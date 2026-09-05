import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // 依頼者のメッセージ本文や認証情報をログに残さない
  redact: {
    paths: ['ev.message.text', 'ev.message', 'body', 'text', 'password', 'token', 'accessToken', 'refreshToken', 'req.headers.authorization', 'req.headers.cookie', '*.headers.authorization', '*.headers.cookie'],
    censor: '[redacted]',
  },
  ...(process.env.NODE_ENV !== 'production' && process.env.LOG_PRETTY !== '0'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
    : {}),
});

export type Logger = typeof logger;
