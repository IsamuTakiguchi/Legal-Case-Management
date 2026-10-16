ALTER TABLE `cases` ADD `onedrive_folder_path` text;--> statement-breakpoint
ALTER TABLE `cases` ADD `onedrive_item_id` text;--> statement-breakpoint
-- 事件が 1 件だけの依頼者は、依頼者フォルダをそのまま事件のフォルダにする（事件が複数ある依頼者は、フォルダ名と事件名で後から照合する）
UPDATE `cases` SET `onedrive_folder_path` = (SELECT `onedrive_folder_path` FROM `clients` WHERE `clients`.`id` = `cases`.`client_id`), `onedrive_item_id` = (SELECT `onedrive_item_id` FROM `clients` WHERE `clients`.`id` = `cases`.`client_id`) WHERE `onedrive_folder_path` IS NULL AND (SELECT count(*) FROM `cases` AS `c2` WHERE `c2`.`client_id` = `cases`.`client_id`) = 1 AND (SELECT trim(coalesce(`onedrive_folder_path`, '')) FROM `clients` WHERE `clients`.`id` = `cases`.`client_id`) <> '';
