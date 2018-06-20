const fs = require('fs');
var lame = require('lame');
var Speaker = require('speaker');
const schedule = require('node-schedule');
const axios = require('axios');
const cheerio = require('cheerio');
const cheerioTableparser = require('cheerio-tableparser');
const say = require('say');
const { Client } = require('pg');
const sha256 = require('sha256');
const _ = require('lodash');
const GENERAL = "GENERAL";
var decode = require('unescape');
const express = require('express');
const morgan = require('morgan');
const app = express();
var oHTTPServer = require('http').Server(app);
var oWebSocketServer = require('http').Server()
var cors = require('cors')
var bodyParser = require('body-parser');
var io = require('socket.io')(oWebSocketServer); // server side of socket, port 9003
const sSelectQuery = 'SELECT * FROM news;'
let aTickers = [GENERAL, "TWTR", "APA", "TEUM", "EXEL"]; // global array

// connect to marketnewsfeed postgres database ( test data on mac, production on dell )
const client = new Client({
  user: process.env.MARKET_NEWS_DB_USER,
  host: process.env.MARKET_NEWS_DB_HOST,
  database: process.env.MARKET_NEWS_DB,
  password: process.env.MARKET_NEWS_DB_PASSWORD,
  port: process.env.MARKET_NEWS_DB_PORT,
});
client.connect();

// CORS: should whitelist; too lazy
app.use(cors());

// bodyParser to get posts from $.ajax
app.use(bodyParser.json());

// Setup logger
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] :response-time ms'));

// scrapes all news from finviz. the article will be added if its hashed datetime of release and title are not already in the database
async function scrapeNews(sIdentifier) {
  if (sIdentifier === GENERAL) {
    return axios.get("https://finviz.com/news.ashx")
      .then(oResponse => parseGeneralTable(oResponse.data))
      .catch(oError => console.log(oError.Error));
  } else { // its a ticker yo - snag that data
    return axios.get("https://finviz.com/quote.ashx?t=" + sIdentifier)
      .then(oResponse => parseTickerTable(oResponse.data, sIdentifier))
      .catch(oError => console.log(oError.Error));
  } 
}

// PMAM numeric time parser helper - rips off PM or AM in a string and adds 12 to the hour if PM
function timeTo24Hour(sTime) {
  let sHour, sMinute, iHour;
  if (sTime.includes('PM')) {
    sTime = sTime.replace('PM', ''); // strip off PM
    sHour = sTime.split(":")[0];
    iHour = parseInt(sHour);
    if (iHour !== 12) {
      sHour = (iHour + 12).toString(); // add twelve to hour if hour is not 12 itself (value range 23)
    }
    sMinute = sTime.split(":")[1];
    sTime = "T" + sHour + ":" + sMinute + ":00";
  } else {
    sTime = sTime.replace('AM', ''); // strip off AM
    sTime = "T" + sTime + ":00";
  }
  return sTime;
}

// time parser helper
function timeToDatetimeString(sFinvizDateTime) {
  let sTime, sDateTime;
  const oMonthRegExp = RegExp('/Jan-|Feb-|Mar-|Apr-|May-|Jun-|Jul-|Aug-|Sep-|Oct-|Nov-|Dec-|/');
  const oPMRegExp = RegExp('/PM/');
  if (oMonthRegExp.test(sFinvizDateTime)) { // date - 
    if (sFinvizDateTime.includes('PM') || sFinvizDateTime.includes('AM')) { // if from stock, it WILL have the time (including PM or AM)
      sDate = sFinvizDateTime.split(" ")[0]; // date part is before space
      sDate = new Date(sDate).toISOString().split('T')[0];
      sTime = sFinvizDateTime.split(" ")[1]; // time part is after space
      sTime = timeTo24Hour(sTime); // parse it
    } else { // if from general news, won't have a time, just 3 letter month and day number - use current year as year, use 00:00:00 as time
      sDate = new Date(sFinvizDateTime + "-2018").toISOString().split('T')[0]; // node is sick we can pass in 'Jun-11' type dates into the date parameter and it works!
      sTime = "T00:00:00";
    }
  } else { // numeric time: AM/PM shit has to be converted to 24hour, then we add todays date
    sDate = new Date().toISOString().split('T')[0]; // use today but the time from the post (be careful of date rollbacks)
    sTime = timeTo24Hour(sFinvizDateTime);
  }
  sDateTime = sDate + sTime;
  return sDateTime;
}
   
const speak = _.debounce(function(sTextToSpeak) { // TODO: don't debounce, but rather add each news peice to a queue and speak them one after another (wait until first done being said, etc)
  console.log(sTextToSpeak);
  googleTextToSpeeachMP3(sTextToSpeak);
}, 1000, {
  'leading': false,
  'trailing': true // play the trailing (newest) news when a big batch comes
});
   
function googleTextToSpeeachMP3(sTextToSpeak) {
  // minimum require interface for google text to speech
  const oData = {
    "input":
    {
      "text": sTextToSpeak
    },
    "voice":
    {
      "languageCode": "en-GB",
      "ssmlGender": "FEMALE"
    },
    "audioConfig":
    {
      "audioEncoding": "mp3"
    }
  };
  axios.post("https://texttospeech.googleapis.com/v1beta1/text:synthesize?fields=audioContent&key=" + process.env.GOOGLE_CLOUD_TEXT_TO_SPEECH_API, oData)
  .then(function (oResponse) {
    // write dat baoss (an encoded string) response into an mp3 file
    io.emit('mp3Data', {sBase64: "data:audio/wav;base64" + oResponse.data.audioContent}); // send to front end to play in GUI
    fs.writeFileSync("report.mp3", oResponse.data.audioContent, 'base64', function(err) { // write this base64 to an mp3
      console.log(err);
    });
    fs.createReadStream("report.mp3")
      .pipe(new lame.Decoder())
      .on('format', function (format) {
        this.pipe(new Speaker(format));
    });
  })
  .catch(function (error) {
    console.log(error);
  });
}   
   
// check if given news ID exists:
function checkExistenceInDatabase(oRow) {
  let sQuery = { text: "SELECT exists(SELECT 1 from news where id='" + oRow.sId + "')" };
  let sNewNewsString;
  client.query(sQuery, (err, oRes) => {
    if (err) {
      console.log(err.stack);
    } else {
      if (!oRes.rows[0].exists) {   // ID does not exist in the table, its a new news item! add it to the DB and tell the network! (notice that if it's not we do nothing)
        insertIntoDatabase(oRow); // now insert the new news peice into the database
      }
    }
  });
}

function hasMonth(sFinvizDateTime) {
  const oMonthRegExp = RegExp('/Jan-|Feb-|Mar-|Apr-|May-|Jun-|Jul-|Aug-|Sep-|Oct-|Nov-|Dec-|/');
  return oMonthRegExp.test(sFinvizDateTime);
}

// if new, insert into news table
function insertIntoDatabase(oRow) {
 let sQuery = {
   text: 'INSERT INTO news(id,news_type,identifier,unix_time_released,title,link) VALUES($1,$2,$3,$4,$5,$6)',
   values: [oRow.sId, oRow.sType, oRow.sIdentifier, oRow.iUnixDateTime, oRow.sTitle, oRow.sLink]
 };
 client.query(sQuery, (err, pg_res) => {
   if (err) {
     console.log(err.stack);
   } else {
     console.log('Successfully saved to DB! '  + oRow.sId);
     sNewsString = "Breaking news for " + oRow.sIdentifier + ": '" + oRow.sTitle;
     speak(sNewsString); // and speak it - see speak function - it is debounced so on a new addition only the most recent is spoken
     io.emit('newNews', oRow ); // and emit the row object to the frontend
   }
 });
}
   
 function parseGeneralTable(oHTML, sIdentifier) {
   let aTableData, sId, sDateTimeString, sTime, sTitle, sLink, sQuery, iCount, oRow, iUnixDateTime;
   const aTableIndexes = [1,3];
   const aTypes = ["News", "Blog"]
   const iBlogTableIndex = 3;
   $ = cheerio.load(oHTML); // load the page response into the cheerio html object
   // loop at the news and blog tables from , then save each as an entry in a postgresql database
   for (var i = 0; i < aTableIndexes.length; i++) {
     iCount = 1;
     do {
       sType = aTypes[i];
       sTime = $("#news > table > tbody > tr:nth-child(2) > td:nth-child(" + aTableIndexes[i] + ") > table > tbody > tr:nth-child(" + iCount + ") > td:nth-child(2)").html();
       sTitle = $("#news > table > tbody > tr:nth-child(2) > td:nth-child(" + aTableIndexes[i] + ") > table > tbody > tr:nth-child(" + iCount + ") > td:nth-child(3) a").html();
       sLink = $("#news > table > tbody > tr:nth-child(2) > td:nth-child(" + aTableIndexes[i] + ") > table > tbody > tr:nth-child(" + iCount + ") > td:nth-child(3) a").attr("href");
       sTitle = decode(sTitle); // remove scrubby HTML characters
       sId = sLink;
       // sId = sha256(sTitle + sLink); // create unique ID from title and URL (primary key of table)
       if (!sTime) {
         break;
       }
       sDateTimeString = timeToDatetimeString(sTime);
       iUnixDateTime = parseInt(new Date(sDateTimeString).getTime() / 1000);
       oRow = { sId: sId, sType: sType, sIdentifier: GENERAL, sDateTimeString: sDateTimeString, iUnixDateTime: iUnixDateTime, sTitle: sTitle, sLink: sLink };
       // console.log(oRow);
       checkExistenceInDatabase(oRow);
       iCount = iCount + 1;
     } while (true);
   }
 }
 
 function parseTickerTable(oHTML, sIdentifier) {
   let iCount, sType, sTime, sDate, sSource, sLink, sTitle, sId, sDateTimeString, iUnixDateTime, oRow;
   $ = cheerio.load(oHTML); // load the page response into the cheerio html object
   iCount = 1;
   do {
     sType = "News";
     sTime = $("#news-table > tbody > tr:nth-child(" + iCount + ") td:nth-child(1)").html();
     sTitle = $("#news-table > tbody > tr:nth-child(" + iCount + ") td:nth-child(2) a").html();
     sSource = $("#news-table > tbody > tr:nth-child(" + iCount + ") td:nth-child(2) span").html();// with stocks we have the text of the news source in a span next to the <a/> tag
     sLink = $("#news-table > tbody > tr:nth-child(" + iCount + ") td:nth-child(2) a").attr("href");
     sTitle = sTitle + " (" + sSource + ")"; // throw news source onto the end of the title
     sTitle = decode(sTitle); // remove scrubby HTML characters
     sId = sLink; // unique ID is title plus link
     // sId = sha256(sTitle + sLink); // create unique ID from title and URL (primary key of table)
     if (!sTime) {
       break;
     } else {
       sTime = sTime.replace(/&#xA0;/g, ""); // replace hex characters since sTime is not null 
     }
     // now check if this date has a month - carry it downwards through the table index so all news has full date and time
     if (hasMonth(sTime)) {
       sDate = sTime.split(" ")[0];
     } else {
       sTime = sDate + " " + sTime; // append date found
     }
     sDateTimeString = timeToDatetimeString(sTime);
     iUnixDateTime = parseInt(new Date(sDateTimeString).getTime() / 1000);
     oRow = { sId: sId, sType: sType, sIdentifier: sIdentifier, iUnixDateTime: iUnixDateTime, sTitle: sTitle, sLink: sLink };
     // console.log(oRow);
     //checkExistenceInDatabase(oRow);
     iCount = iCount + 1;
   } while (true);
   // TODO: then parse each link, run some NLP stuff? honestly media is just a bunch of shit but maybe we could glean generalities
 }
 
 // scrape every 1 minute - call the scrapeNews function for each identifier
 function scanForNews(aIdentifiers) {
   let scanForNewsJob = schedule.scheduleJob('1 * * * * *', function() { // run each minute
       aIdentifiers.forEach(sIdentifier => scrapeNews(sIdentifier));
   });
   console.log("Scanning for breaking news on the following identifiers: " + aIdentifiers)
 }

//scrapeNews(GENERAL);
//scrapeNews("TWTR");

scanForNews(aTickers); // TODO: make this a web call (or desktop or mobile app call)

// return all news found so far to front end
app.get("/market-news-feed-api", function(req, res) {
  client.query(sSelectQuery, (err, oResponse) => {
    if (err) {
      console.log(err.stack)
    } else {
      // TODO: filter out any tickers that are not in the global list
      res.send(JSON.stringify(oResponse.rows.reverse()));
      res.end(200);
    }
  });
});

// return tickers to front end
app.get("/tickers", function(req, res) {
    res.send(JSON.stringify(aTickers));
    res.end(200);
});

// add ticker to global list
app.post("/add-ticker", function(req, res) {
  let sTicker = req.body.sTicker;
  if (!aTickers.contains(sTicker)) { // only add ticker if it is not in the list
    aTickers.push(sTicker);
  }
  res.end(200);
});

// delete ticker from global list
app.post("/delete-ticker", function(req, res) {
  let sTicker = req.body.sTicker;
  if (aTickers.contains(sTicker)) {
    _.pull(aTickers, sTicker); // remove that ticker!
  }
  res.end(200);
});

// listening ports - reverse proxyed from nginx chrisfrew.in/market-news-api
oHTTPServer.listen(9002, function() {
  console.log('HTTP Server listening on port ' + 9002);
});// we run at 9001 and up for APIs (9000 reserved for API tests)

oWebSocketServer.listen(9003, function() {
  console.log('Websocket Server listening on port ' + 9003);
});

setInterval(() => {
  console.log("emitting various...");
  io.emit("test", {test: 'testdata'});
  //io.sockets.emit("test", {test: 'testdata'});
  //io.of("/market-news-feed-ws").emit("test", {test: 'testdata'});
},3000);

