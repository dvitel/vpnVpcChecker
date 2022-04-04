const { testVpnVpc, testVpc } = require("./protocols")
const express = require("express")
const config = require("./config.json")
const { parse } = require("csv-parse/sync")
const fs = require("fs")
const package = require("./package.json")
const criticalSection = require("./criticalSection")
const { exec } = require("child_process")

let ipPattern = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
let localSection = new criticalSection.CriticalSection()

let students = parse(fs.readFileSync("students.csv"), {
    columns: true, skip_empty_lines: true
})

function loadStats(statsFile) {
    let stats = {} //object with all student runs in memory 
    try {
        stats = JSON.parse(fs.readFileSync(statsFile))
    } catch (e) {
        console.error(`Cannot read file ${statsFile}`, e);
        stats = {}
    } 
    return stats;
}

let vpcStats = loadStats(config.vpcStatsFile);
let providedBastionIps = {};
Object.keys(vpcStats).forEach(login => 
    (vpcStats[login].bastions || []).forEach(bastion => {
        if (!providedBastionIps[bastion]) providedBastionIps[bastion] = {}
        providedBastionIps[bastion][login] = 1;
}))
let vpnVpcStats = loadStats(config.vpnVpcStatsFile);
let sshKey = fs.readFileSync(config.sshKey);

let isServerMode = process.argv.includes("--server")
let isVpc = process.argv.includes("--vpc")

if (isServerMode) {

    const app = express()
    app.use(express.static('www'))
    app.use(express.json());
    //let db = new DynamoDBClient()

    // app.get("/", (req, res) => {
    //     res.send("Infrastructure testing server " + package.version);
    // })

    app.post("/vpc", async (req, res) => {        
        if (localSection.releasePromises.length >= 20) { //server is busy 
            res.statusCode = 429;
            res.send({"error": "Server is busy. Try again later"});
            return;
        }
        let { login = "", bastionServer = "", sshServer = "" } = req.body || {};
        let validation = { login: null, bastionServer: null, sshServer: null, rdpServer: null }
        if (!ipPattern.test(bastionServer)) validation.bastionServer = "VPN server is not valid IP address";
        if (!ipPattern.test(sshServer)) validation.sshServer = "SSH server is not valid IP address";
        let student = students.find(s => s.Login == login);
        if (!student) validation.login = "Specified login is incorrect";        
        if (Object.keys(validation).some(prop => validation[prop])) {
            res.status(400);
            res.send({fields: validation, error: "Some fields are incorrect"});
        } else {
            // let uNumber = student.ID;
            // if (uNumber.startsWith("U")) uNumber = uNumber.substring(1);
            let result = await testVpc({ login, bastionServer, sshServer, sshKey, providedBastionIps });
            await criticalSection(async () => {   
                let timestamp = new Date();
                if (!vpcStats[student.Login]) vpcStats[student.Login] = { name: student.Student, uid: student.ID, bastions: [] };
                let record = vpcStats[student.Login]
                record.lastScore = result.score; 
                record.lastScoreTimestamp = timestamp;
                if (!record.bastions.includes(bastionServer)) record.bastions.push(bastionServer);
                if (!record.bestScore) {
                    record.bestScore = result.score; 
                    record.bestScoreTimestamp = timestamp;
                }
                else if (record.bestScore < result.score) record.bestScore = result.score;
                if (!record.logs) record.logs = []
                record.logs.push({ score: result.score, timestamp, log: result.log } );
                let writeResolved = null;
                let writePromise = new Promise(res => writeResolved = res)
                fs.writeFile(config.vpcStatsFile, JSON.stringify(vpcStats), () => {
                    writeResolved();
                }); //we do not await writing - potentially possible race conditions ?? - should not be
                await writePromise;
            }, localSection);
            res.send(result);
        }
    })

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
                let result = await testVpnVpc({id:uNumber, vpnServer, sshServer, rdpServer, sshKey });
                let timestamp = new Date();
                if (!vpnVpcStats[student.Login]) vpnVpcStats[student.Login] = { name: student.Student, uid: student.ID };
                let record = vpnVpcStats[student.Login]
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
                fs.writeFile(config.vpnVpcStatsFile, JSON.stringify(vpnVpcStats), () => {
                    writeResolved();
                }); //we do not await writing - potentially possible race conditions ?? - should not be
                await writePromise;
                return result;
            }, localSection);
            res.send(result);
        }
    })
    
    app.listen(config.server.port, () => console.log(`Server started at http://localhost:${config.server.port}`));        
} else if (isVpc) {
    testVpc({ sshKey }); //no await
} else {
    testVpnVpc({ sshKey });
}