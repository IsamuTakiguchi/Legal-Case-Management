-- 対応中・完了のタスクで、期日が「返信待ちの期限」の欄にだけ入っているものを、期日の欄に移す。
-- これまでは対応中の期日をこちらに持つことがあり、返信待ちにすると上書きされて消えていた
UPDATE `tasks` SET `due_at` = `follow_up_at` WHERE `status` IN ('open', 'done') AND `due_at` IS NULL AND `follow_up_at` IS NOT NULL;
