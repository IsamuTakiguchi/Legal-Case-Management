import React from 'react';
import ReactDOM from 'react-dom/client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { pruneDrafts } from './lib/draft';
import { preventStrayFileDrops } from './lib/LocalFileAttach';
import './index.css';

// PWA: 本番ビルドでのみサービスワーカーを登録（ホーム画面追加・インストールに必要）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

// 添付できる欄の外にファイルを落としても、ブラウザがファイルを開いて書きかけが消えないようにする
preventStrayFileDrops();

// 期限切れの入力途中の下書きを片付ける
pruneDrafts();

/**
 * メニューの件数（受信箱・タスク・要確認）は 1 分ごとに取り直しているが、
 * それだけだとアーカイブや完了の直後に数が古いままになる。
 * 何か操作が成功したら、その場で取り直す（画面ごとに書き忘れないよう、ここでまとめて行う）。
 */
const mutationCache = new MutationCache({
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
  },
});

const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
