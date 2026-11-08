import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import ExcelJS from 'exceljs';

/**
 * ファイルの本文を取り出す（Word・PDF・Excel・テキスト）。
 * 重い処理なので、サーバー本体からは forms.ts の extractText（別スレッドで動かし、時間とメモリに上限を付ける）を使う。
 * ここはデータベースなどに触れない（別スレッドからも読み込めるように）
 */
export async function extractTextInline(name: string, data: Buffer): Promise<string> {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'docx') {
    const r = await mammoth.extractRawText({ buffer: data });
    return r.value;
  }
  if (ext === 'pdf') {
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try {
      const r = await parser.getText();
      return r.text;
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
  if (ext === 'xlsx' || ext === 'xlsm') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as unknown as ArrayBuffer);
    const parts: string[] = [];
    wb.eachSheet((ws) => {
      parts.push(`# ${ws.name}`);
      ws.eachRow((row) => {
        const vals = (row.values as unknown[]).slice(1).map((v) => (v === null || v === undefined ? '' : typeof v === 'object' && 'text' in (v as object) ? String((v as { text: unknown }).text) : String(v)));
        if (vals.some((v) => v)) parts.push(vals.join('\t'));
      });
    });
    return parts.join('\n');
  }
  if (ext === 'txt') return data.toString('utf8');
  throw new Error(`本文抽出に未対応の形式: ${ext}`);
}
