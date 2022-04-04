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
    console.log("Testing: ", data);
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
        let { score, log, fields } = json;
        if (fields) {
            Object.keys(fields).forEach(fieldId => document.getElementById(fieldId).classList.add("is-invalid"));
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
    document.getElementById("testAll").disabled = false;
    inProgress = false;
})