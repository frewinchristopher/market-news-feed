# Finviz-based Market News Feed

This node module scrapes the news and blogs tables at (https://finviz.com/news.ashx)[https://finviz.com/news.ashx] once every minute, and attempts to add the url (among other things like the title of the article, ticker it is tracking, etc.) to a postgresql table. If the news article link hasn't been found in the DB yet, it is added.

## Requirements

PATH variables with the following names:

MARKET_NEWS_DB_USER - the user of your postgresql database
MARKET_NEWS_DB_HOST - the hostname of postgresql (usually is 127.0.0.1)
MARKET_NEWS_DB - the database name
MARKET_NEWS_DB_PASSWORD - the user's password to postgresql
MARKET_NEWS_DB_PORT - the port (usually is 5432)

_If you don't know how to install postgresql and set PATH variables, I may consider writing a no-DB version, but I like postgresql :)_

Then, you have to create a new table called `news` in your chosen database. Issue in postgresql the following commands:

`CREATE TABLE news(id varchar, news_type varchar, identifier varchar, unix_time_released bigint, title varchar, link varchar, PRIMARY KEY (id));`

GOOGLE_CLOUD_TEXT_TO_SPEECH_API - the API key of your text to speech API

_This one is kind of mandatory if you want nice reading of the news titles. If you prefer just text - you're in luck - each new news article found is printed to the console_

## Installation

Once you've added the environment variables, this should install fine with:

`npm install`

and run with:

`node index.js`

If you've put in the correct API credentials for google, you'll hear a nice female voice read out to you the newest headline. If not, you'll at least see the new news printed to the console.