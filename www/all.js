let inProgress = false;
document.getElementById("testingForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    if (inProgress) return;
    inProgress = true;
    let form = document.getElementById("testingForm");
    let formData = new FormData(form);
    let data = {};
    formData.forEach((value, key) => {
        document.getElementById(key).classList.remove("is-invalid")
        data[key] = value;
    });    
    document.getElementById("progress").classList.remove("d-none");
    document.getElementById("testAll").disabled = true;
    try {
        let resp = await fetch(endpointUrl, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        })        
        let json = await resp.json();
        console.log("Resp: ", json);
        let { score, log, fields } = json;
        if (fields) {
            Object.keys(fields).filter(fieldId => fields[fieldId]).forEach(fieldId => {
                let fieldEl = document.getElementById(fieldId);
                if (fieldEl) fieldEl.classList.add("is-invalid")
            });
        } else {
            document.getElementById("scoreBlock").classList.remove("d-none");
            if (score != null) document.getElementById("scoreHolder").classList.remove("d-none");
            document.getElementById("score").innerText = score || 0;
            document.getElementById("log").value = log.join("\n");
        }
    } catch (e) {
        document.getElementById("scoreBlock").classList.remove("d-none");
        console.error("Testing: ", e);
        document.getElementById("log").value = e.toString();
    }
    document.getElementById("progress").classList.add("d-none");
    setTimeout(() => {
        document.getElementById("testAll").disabled = false;
    }, 2000);
    inProgress = false;
})