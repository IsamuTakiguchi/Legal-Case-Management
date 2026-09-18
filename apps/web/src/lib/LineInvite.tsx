import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface LineInviteInfo {
  configured: boolean;
  basicId: string | null;
  displayName: string | null;
  addUrl: string | null;
  qrSvg: string | null;
  reason: string | null;
  message: string | null;
  waiting: { id: number; name: string; invitedAt: string | null }[];
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 友だち追加をお願いするための案内（URL・QR・案内文）。
 *
 * LINE では、相手が友だち追加するかメッセージを送ってくるまで相手の ID を取得できない
 * （友だち一覧 API は認証済／プレミアムアカウント専用）。
 * そのため「ID を調べて登録する」ことはできず、この URL か QR で追加してもらうのが唯一の入口になる。
 */
export function LineInvitePanel({ clientId, invitedAt, onChanged }: { clientId?: number | null; invitedAt?: string | null; onChanged?: () => void }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState('');
  const invite = useQuery({
    queryKey: ['line-invite', clientId ?? null],
    queryFn: () => api.get<LineInviteInfo>(`/line/invite${clientId ? `?clientId=${clientId}` : ''}`),
    retry: false,
  });
  const mark = useMutation({
    mutationFn: (invited: boolean) => api.post<{ invitedAt: string | null }>(`/clients/${clientId}/line-invite`, { invited }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['line-invite'] });
      qc.invalidateQueries({ queryKey: ['clients'] });
      onChanged?.();
    },
  });
  const d = invite.data;

  return (
    <div className="fade-in space-y-2 rounded border border-green-200 bg-green-50/40 p-2">
      <div className="text-xs text-slate-600">
        LINE では、相手が友だち追加するまで相手の ID を知ることができません（ID を調べる方法はありません）。下の URL か QR で友だち追加してもらうと、
        「要確認」に通知が出て、そこから依頼者に紐付けられます。
      </div>

      {invite.isPending && <div className="loading-text text-xs text-slate-500">LINE公式アカウントの情報を取得しています…</div>}
      {invite.isError && <div className="text-xs text-red-600">取得できませんでした: {(invite.error as Error).message}</div>}
      {d && !d.addUrl && <div className="text-xs text-red-600">{d.reason ?? 'LINE公式アカウントの情報を取得できませんでした'}</div>}

      {d?.addUrl && (
        <>
          <div className="flex flex-wrap items-start gap-3">
            {d.qrSvg && (
              <div
                className="h-28 w-28 shrink-0 rounded bg-white p-1 [&>svg]:h-full [&>svg]:w-full"
                // 自分の LINE公式アカウントの友だち追加 QR。サーバで作った SVG をそのまま出す
                dangerouslySetInnerHTML={{ __html: d.qrSvg }}
                aria-label="友だち追加の QR コード"
              />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-xs text-slate-500">
                {d.displayName ?? 'LINE公式アカウント'}
                {d.basicId ? `（${d.basicId}）` : ''}
              </div>
              <input className="input py-0.5 text-xs" readOnly value={d.addUrl} onFocus={(e) => e.currentTarget.select()} />
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => copy(d.addUrl!).then((ok) => setCopied(ok ? 'url' : 'fail'))}
                  title="この URL を依頼者に送ってください（メール・Chatwork・SMS など）"
                >
                  URL をコピー
                </button>
                {d.message && (
                  <button type="button" className="btn btn-sm" onClick={() => copy(d.message!).then((ok) => setCopied(ok ? 'msg' : 'fail'))} title="そのまま送れる案内文をコピーします">
                    案内文をコピー
                  </button>
                )}
                <a className="btn btn-sm" href={d.addUrl} target="_blank" rel="noreferrer">
                  開く
                </a>
                {copied === 'url' && <span className="fade-in text-xs text-green-700">URL をコピーしました</span>}
                {copied === 'msg' && <span className="fade-in text-xs text-green-700">案内文をコピーしました</span>}
                {copied === 'fail' && <span className="fade-in text-xs text-slate-500">コピーできませんでした。手で選んでコピーしてください</span>}
              </div>
            </div>
          </div>

          {clientId ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-green-200 pt-2 text-xs">
              {invitedAt ? (
                <>
                  <span className="rounded bg-amber-100 px-1 text-amber-800">LINE 連携待ち</span>
                  <span className="text-slate-500">この依頼者が友だち追加すると、要確認の通知にワンタップで紐付けるボタンが出ます</span>
                  <button type="button" className="ml-auto hover:underline" onClick={() => mark.mutate(false)} disabled={mark.isPending}>
                    連携待ちをやめる
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => mark.mutate(true)} disabled={mark.isPending}>
                    {mark.isPending ? '設定中…' : '友だち追加をお願い中にする'}
                  </button>
                  <span className="text-slate-500">この依頼者が友だち追加したとき、要確認の通知ですぐ紐付けられるようにします</span>
                </>
              )}
            </div>
          ) : (
            <div className="border-t border-green-200 pt-2 text-xs text-slate-500">依頼者を保存すると「友だち追加をお願い中」にでき、追加されたときにすぐ紐付けられます</div>
          )}

          {mark.isError && <div className="text-xs text-red-600">{(mark.error as Error).message}</div>}
          {d.waiting.length > 0 && (
            <div className="text-xs text-slate-500">
              いま連携待ちの依頼者: {d.waiting.map((w) => w.name).join('・')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
