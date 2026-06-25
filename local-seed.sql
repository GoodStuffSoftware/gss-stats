CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, site TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
  lat TEXT NOT NULL DEFAULT '', lon TEXT NOT NULL DEFAULT '', colo TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT ''
);
INSERT INTO hits (ts,site,path,country,region,city,device) VALUES
 (strftime('%s','now')*1000,'starrupture','/','US','California','Los Angeles','desktop'),
 (strftime('%s','now')*1000,'starrupture','/','US','Texas','Austin','mobile'),
 (strftime('%s','now')*1000,'simpletile','/','US','California','San Francisco','desktop'),
 (strftime('%s','now')*1000,'starrupture','/star','US','New York','New York','mobile'),
 (strftime('%s','now')*1000,'simpletile','/','GB','England','London','desktop');
