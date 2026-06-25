DROP TABLE IF EXISTS hits;
CREATE TABLE hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, site TEXT DEFAULT '', path TEXT DEFAULT '', referrer TEXT DEFAULT '',
  country TEXT DEFAULT '', region TEXT DEFAULT '', city TEXT DEFAULT '', postal TEXT DEFAULT '',
  continent TEXT DEFAULT '', timezone TEXT DEFAULT '', lat TEXT DEFAULT '', lon TEXT DEFAULT '',
  colo TEXT DEFAULT '', org TEXT DEFAULT '', device TEXT DEFAULT '', browser TEXT DEFAULT '',
  os TEXT DEFAULT '', lang TEXT DEFAULT '', screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new'
);
INSERT INTO hits (ts,site,path,referrer,country,region,city,postal,lat,lon,org,device,browser,os,lang,visitor) VALUES
 (strftime('%s','now')*1000,'starrupture','/','reddit.com','US','California','Los Angeles','90012','34.05','-118.24','Spectrum','desktop','Chrome','Windows','en-US','new'),
 (strftime('%s','now')*1000,'starrupture','/','reddit.com','US','Texas','Austin','73301','30.27','-97.74','AT&T','mobile','Safari','iOS','en-US','new'),
 (strftime('%s','now')*1000,'simpletile','/','','US','California','San Francisco','94016','37.77','-122.42','Comcast','desktop','Firefox','macOS','en-US','returning'),
 (strftime('%s','now')*1000,'starrupture','/star','google.com','US','New York','New York','10001','40.71','-74.01','Verizon','mobile','Chrome','Android','en-US','new'),
 (strftime('%s','now')*1000,'simpletile','/','','GB','England','London','EC1A','51.51','-0.13','BT','desktop','Chrome','Linux','en-GB','new');
