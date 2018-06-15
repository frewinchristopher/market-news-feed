const { Client } = require('pg');

const client = new Client({
  user: process.env.MARKET_NEWS_DB_USER,
  host: process.env.MARKET_NEWS_DB_HOST,
  database: process.env.MARKET_NEWS_DB,
  password: process.env.MARKET_NEWS_DB_PASSWORD,
  port: process.env.MARKET_NEWS_DB_PORT,
});
client.connect();


let sQuery;
// first check if it exists:
sQuery = { text: "SELECT exists(SELECT 1 from news where id='12')" };
client.query(sQuery, (err, oRes) => {
  console.log(oRes.rows[0].exists);
});