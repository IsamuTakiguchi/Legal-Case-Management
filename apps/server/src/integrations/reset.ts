/** 接続情報を保存し直したときに、各クライアントのキャッシュを破棄する */
import { resetGoogleClient } from './google.js';
import { resetMsalClient } from './onedrive.js';
import { resetZoomTokenCache } from './zoom.js';
import { resetAnthropicClient } from './anthropic.js';
import { setStorageBackend } from './storage.js';

export function resetIntegrationCaches() {
  resetGoogleClient();
  resetMsalClient();
  resetZoomTokenCache();
  resetAnthropicClient();
  setStorageBackend(null);
}
