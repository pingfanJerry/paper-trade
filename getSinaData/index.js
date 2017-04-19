import redis from 'redis'
import request from 'request'
import Config from '../config'
import amqp from 'amqplib'
import Iconv from 'iconv-lite'
import StockRef from './stocksRef'
import sqlstr from '../common/sqlStr'
var client = Config.CreateRedisClient();
const sequelize = Config.CreateSequelize();
var stockRef = new StockRef()
var listenerSymbol = new Map() //订阅者关注的股票
    // var ETFS = []
var stockInfo = {}
    /**获取查询股票的代码sina */
function getQueryName({ QueryUrlCode, SecuritiesNo }) {
    return QueryUrlCode + SecuritiesNo.toLowerCase().replace(".", "$")
}
/**rabbitmq 通讯 */
async function startMQ() {
    var amqpConnection = await amqp.connect(Config.amqpConn)
    let channel = await amqpConnection.createChannel()
    await channel.assertExchange("broadcast", "fanout")
    let ok = await channel.assertQueue('sinaData')
    ok = await channel.assertQueue("getSinaData")
    channel.consume('getSinaData', msg => {
        var { symbols, listener, type } = JSON.parse(msg.content.toString())
        if (!symbols) symbols = []
        if (!listenerSymbol.has(listener)) listenerSymbol.set(listener, [])
        let oldSymbols = listenerSymbol.get(listener)
        let needAdd = [] //需要增加的股票
        let needRemove = [] //需要删除的股票
        switch (type) {
            case "reset": //重置该订阅者所有股票
                console.log(listener, type)
                if (oldSymbols) {
                    needRemove = oldSymbols.concat() //复制一份
                    for (let s of symbols) { //查找已有的和没有的
                        if (needRemove.contain(s)) { //已经存在
                            needRemove.remove(s) //不进入移除列表
                        } else {
                            needAdd.push(s)
                        }
                    }
                } else {
                    needAdd = symbols
                }
                listenerSymbol.set(listener, symbols)
                break
            case "add":
                while (symbols.length) {
                    let symbol = symbols.pop()
                    if (oldSymbols.contain(symbol)) {
                        continue
                    } else {
                        needAdd.push(symbol)
                        oldSymbols.push(symbol)
                    }
                }
                break
            case "remove":
                while (symbols.length) {
                    let symbol = symbols.pop()
                    if (oldSymbols.contain(symbol)) {
                        needRemove.remove(symbol)
                        oldSymbols.push(symbol)
                    } else {
                        continue
                        needAdd.push(symbol)
                    }
                }
                break
        }
        if (needRemove.length) stockRef.removeSymbols(needRemove)
        if (needAdd.length) stockRef.addSymbols(needAdd)
        channel.ack(msg)
    })
    ok = await channel.bindQueue('sinaData', 'broadcast', 'fanout')
    console.log(ok, channel.sendToQueue('sinaData', new Buffer("restart")))
        //获取中概股
    let [ccss] = await sequelize.query("select * from wf_securities_trade where ShowType='CCS'")
    stockRef.addSymbols(ccss.map(ccs => getQueryName(ccs)))
    for (let ccs of ccss) {
        stockInfo[getQueryName(ccs)] = ccs
    }
    //获取明星股
    let [gss] = await sequelize.query("select * from wf_securities_trade where ShowType='GS'")
    stockRef.addSymbols(gss.map(gs => getQueryName(gs)))
    for (let gs of gss) {
        stockInfo[getQueryName(gs)] = gs
    }
    /**获取ETF */
    // let [etfs] = await sequelize.query("select * from wf_securities_trade where ShowType='ETF'")
    // for (let etf of etfs) {
    //     Object.deleteProperties(etf, "")
    // }
    //    "SecuritiesID": 16700,
    //         "SecuritiesNo": "IPU",
    //         "SecuritiesName": "SPDR S&P International Utilities",
    //         "Remark": "",
    //         "BigType": "gp",
    //         "SmallType": "us",
    //         "QueryUrlCode": "gb_",
    //         "PinYin": "SPDR S&P International Utilitie",
    //         "FirstPinYin": "IPU",
    //         "Trade_ParentID": null,
    //         "Trade_ID": null,
    //         "Expand": "AM",
    //         "ShowType": "ETF",
    //         "delta": 0
    // stockRef.addSymbols(etfs.map(etf => etf.QueryUrlCode + etf.SecuritiesNo.toLowerCase()))
    // ETFS = etfs
}

var intervalId;
var pageSize = 1000;

function start() {
    intervalId = setInterval(async() => {
        let marketIsOpen = await redisClient.getAsync("marketIsOpen")
        marketIsOpen = JSON.parse(marketIsOpen)
            //let stocks = marketIsOpen.us?Array.from(marketIsOpen.us):
        if (stocks.length && client.connected) {
            let l = stocks.length;
            let i = 0
            let stocks_name = ""
            let currentRankTable = await client.getAsync("currentSRT")
            if (!currentRankTable) {
                currentRankTable = "wf_securities_rank_a"
                client.set("currentSRT", "wf_securities_rank_b")
            } else {
                await client.setAsync("currentSRT", currentRankTable == "wf_securities_rank_a" ? "wf_securities_rank_b" : "wf_securities_rank_a")
                sequelize.query("truncate table " + currentRankTable);
            }
            //let sinaData = {}
            while (l) {
                if (l > pageSize) {
                    stocks_name = stocks.slice(i, i + pageSize).join(",")
                    l -= pageSize
                    i += pageSize
                } else {
                    stocks_name = stocks.slice(i, i + l).join(",")
                    l = 0
                }
                request.get({ encoding: null, url: Config.sina_realjs + stocks_name.toLowerCase() }, (error, response, body) => {
                    let rawData = Iconv.decode(body, 'gb2312')
                    let config = Config
                    let redisClient = client
                    let _sqlstr = sqlstr
                    let insertSql = "insert into " + currentRankTable + "(SecuritiesType,SecuritiesNo,SecuritiesName,NewPrice,RiseFallRange,ShowType) values"
                        //let sd = sinaData
                    eval(rawData + ` 
                    let values = []
                    for (let stockName of stocks){
                        let q = config.stockPatten.exec(stockName)[1];
                        let x=eval("hq_str_" + stockName).split(",");
                        let price = config.pricesIndexMap[q].map(y=>Number(x[y]));
                        if(Number.isNaN(price[4]))price[4]=0;
                        price[5] = price[4]? (price[3] - price[4]) * 100 / price[4]:0;
                        redisClient.set("lastPrice:"+stockName,price.join(","));
                        values.push("('"+stockInfo[stockName].SmallType+"','"+stockInfo[stockName].SecuritiesNo+"','"+(stockInfo[stockName].SecuritiesName).replace(/'/g,"’")+"',"+price[4]+","+price[5]+",'"+stockInfo[stockName].ShowType+"')")
                    }
                    insertSql+=values.join(",")
                    sequelize.query(insertSql)
                    `)
                })
            }
            // for (let etf of ETFS) {
            //     let stock_name = etf.QueryUrlCode + etf.SecuritiesNo.toLowerCase()
            //     let [Open, High, Low, Last, PreClose, Delta] = sinaData[stock_name] ? sinaData[stock_name] : []
            //     Object.assign(etf, { Open, High, Low, Last, PreClose, Delta })
            // }
            // ETFS.sort((a, b) => a.Delta > b.Delta)

        }
    }, 5000)
}

function stop() {
    clearInterval(intervalId)
}

startMQ()
start()