// Temporary debug endpoint - returns a page with a script that reads localStorage
// and displays the LOPEZ client data for TIR debugging.
// Access at: http://localhost:3000/api/debug-lopez

export async function GET() {
    const html = `<!DOCTYPE html>
<html><head><title>Debug LOPEZ TIR</title></head>
<body style="background:#111;color:#eee;font-family:monospace;padding:20px;">
<h2>Debug: Julian Alejandro LOPEZ - TIR Data</h2>
<pre id="output">Loading...</pre>
<script>
try {
    const raw = localStorage.getItem('ap-dashboard-data');
    if (!raw) { document.getElementById('output').textContent = 'No data in localStorage'; }
    else {
        const state = JSON.parse(raw);
        const clients = state.clients || {};
        const lopezKey = Object.keys(clients).find(k => clients[k].name && clients[k].name.includes('LOPEZ'));
        
        if (!lopezKey) {
            document.getElementById('output').textContent = 'LOPEZ not found. Client keys: ' + Object.keys(clients).join(', ');
        } else {
            const c = clients[lopezKey];
            const result = {
                name: c.name,
                accountNumber: c.accountNumber,
                snapshotCount: c.snapshots.length,
                snapshots: c.snapshots.map(s => ({
                    date: s.date,
                    totalValue: s.totalValue,
                    securitiesValue: s.securitiesValue,
                    availablePesos: s.availablePesos,
                    availableDolares: s.availableDolares,
                    holdingsCount: (s.holdings || []).length
                })),
                tirFlowKeys: c.tirFlowKeys || [],
                manualFlows: c.manualFlows || [],
                allDepositWithdrawals: (c.movements || [])
                    .filter(m => m.classification === 'DEPOSIT' || m.classification === 'WITHDRAWAL')
                    .map(m => ({
                        movNumber: m.movNumber,
                        date: m.concertDate,
                        classification: m.classification,
                        monto: m.monto,
                        moneda: m.moneda,
                        tipoMov: m.tipoMov
                    })),
                ratesHistory: state.ratesHistory || {},
                selectedCurrency: state.selectedCurrency
            };
            document.getElementById('output').textContent = JSON.stringify(result, null, 2);
        }
    }
} catch(e) {
    document.getElementById('output').textContent = 'Error: ' + e.message;
}
</script>
</body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
