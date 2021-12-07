const { testAll } = require("./protocols")
const express = require("express")
const config = require("./config.json")
const { parse } = require("csv-parse/sync")
const fs = require("fs")
const package = require("./package.json")
const criticalSection = require("./criticalSection")

let ipPattern = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
let localSection = new criticalSection.CriticalSection()

let students = parse(fs.readFileSync("students.csv"), {
    columns: true, skip_empty_lines: true
})

let stats = {} //object with all student runs in memory 
try {
    stats = JSON.parse(fs.readFileSync(config.statsFile))
} catch (e) {
    stats = {}
} 

let isServerMode = process.argv.includes("--server")

if (isServerMode) {

    const app = express()
    app.use(express.static('www'))
    app.use(express.json());
    //let db = new DynamoDBClient()

    // app.get("/", (req, res) => {
    //     res.send("Infrastructure testing server " + package.version);
    // })

    app.post("/vpn-vpc", async (req, res) => {        
        if (localSection.releasePromises.length >= 10) { //server is busy 
            res.statusCode = 429;
            res.send({"error": "Server is busy. Try again later"});
            return;
        }
        let { login = "", vpnServer = "", sshServer = "", rdpServer = "" } = req.body || {};
        let validation = { login: null, vpnServer: null, sshServer: null, rdpServer: null }
        if (!ipPattern.test(vpnServer)) validation.vpnServer = "VPN server is not valid IP address";
        if (!ipPattern.test(sshServer)) validation.sshServer = "SSH server is not valid IP address";
        if (!ipPattern.test(rdpServer)) validation.rdpServer = "RDP server is not valid IP address";
        let student = students.find(s => s.Login == login);
        if (!student) validation.login = "Specified login is incorrect";        
        if (Object.keys(validation).some(prop => validation[prop])) {
            res.status(400);
            res.send({fields: validation, error: "Some fields are incorrect"});
        } else {
            let uNumber = student.ID;
            if (uNumber.startsWith("U")) uNumber = uNumber.substring(1);
            let result = await criticalSection(async () => {
                let result = await testAll({id:uNumber, vpnServer, sshServer, rdpServer });
                let timestamp = new Date();
                if (!stats[student.Login]) stats[student.Login] = { name: student.Student, uid: student.ID };
                let record = stats[student.Login]
                record.lastScore = result.score; 
                record.lastScoreTimestamp = timestamp;
                if (!record.bestScore) {
                    record.bestScore = result.score; 
                    record.bestScoreTimestamp = timestamp;
                }
                else if (record.bestScore < result.score) record.bestScore = result.score;
                if (!record.logs) record.logs = []
                record.logs.push({ score: result.score, timestamp, log: result.log } );
                let writeResolved = null;
                let writePromise = new Promise(res => writeResolved = res)
                fs.writeFile(config.statsFile, JSON.stringify(stats), () => {
                    writeResolved();
                }); //we do not await writing - potentially possible race conditions ?? - should not be
                await writePromise;
                return result;
            }, localSection);
            res.send(result);
        }
    })
    
    app.listen(config.server.port, () => console.log(`Server started at http://localhost:${config.server.port}`));        
} else {
    testAll({}); //no await
}