//module implements code serialization of async block with promises 

function CriticalSection() {
    this.taken = false;
    this.releasePromises = [];
}

let globalCritSection = new CriticalSection();

/** @param critSection: CriticalSection  */
module.exports = async function (atomicAction, critSection = null, ...atomicActionArgs) {
    if (!critSection) critSection = globalCritSection;
    if (critSection.taken) { //we need to wait
        let exitResolved = null;
        let exitPromise = new Promise(res => exitResolved = res);;
        critSection.releasePromises.push(exitResolved);
        await exitPromise;        
    }
    //we enter section
    critSection.taken = true;
    //entered critical section
    let res = (typeof atomicAction == "function") ? await atomicAction(atomicActionArgs) : await atomicAction;
    //release first waiter
    let releaseWaiter = critSection.releasePromises.shift();
    if (releaseWaiter) releaseWaiter(); //have at least one waiter - release it - it will release next
    else critSection.taken = false; //no more waiters
    return res;
}

module.exports.CriticalSection = CriticalSection;