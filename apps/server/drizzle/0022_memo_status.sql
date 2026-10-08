-- 時期未定の備忘は、きっかけが来るまでタスクとして数えない（専用の状態 memo にする）。
-- これまで「対応中」で持っていた、締切の無い備忘を移す
UPDATE `tasks` SET `status` = 'memo' WHERE `status` = 'open' AND `trigger` IS NOT NULL AND `due_at` IS NULL;
