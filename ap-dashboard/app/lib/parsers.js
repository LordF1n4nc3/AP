/**
 * Parser for IOL "Resumen de Cuenta" PDF files (tenencias/holdings)
 * These PDFs contain client info + portfolio positions
 */

export function parseTenenciaPDF(textContent) {
    const text = textContent.trim();

    // Extract client name (first tokens before address)
    // Pattern: "Name SURNAME address..."
    // The name is followed by the address which contains numbers
    const lines = text.replace(/\s+/g, ' ').trim();

    // Extract date - format: dd/m/yyyy or dd/mm/yyyy
    // IMPORTANT: Look specifically for "Fecha Estado de Cta" first (IOL specific),
    // otherwise fall back to the first date found in the text.
    const specificDateMatch = lines.match(/Fecha\s+Estado\s+(?:de\s+)?Cta[.:]*\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const genericDateMatch = lines.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    const dateMatch = specificDateMatch || genericDateMatch;
    const reportDate = dateMatch ? dateMatch[1] : null;

    // Extract account numbers - the two numbers after the date
    const afterDate = dateMatch
        ? lines.substring(lines.indexOf(dateMatch[0]) + dateMatch[0].length).trim()
        : '';
    const accountNumbers = afterDate.match(/^(\d+)\s+(\d+)/);
    const accountNumber = accountNumbers ? accountNumbers[1] : null;
    const refNumber = accountNumbers ? accountNumbers[2] : null;

    // Extract name and address from text before the date
    // Examples from IOL PDFs:
    //   "Bruno BENINCA CABILDO 2775 ..." → "Bruno BENINCA"
    //   "Ignacio CANE gervasio mendez 3283 1 ..." → "Ignacio CANE"
    //   "Matias Cristian Balsalobre CONCEJAL NATALIO 1234" → "Matias Cristian Balsalobre"
    const beforeDate = dateMatch
        ? lines.substring(0, lines.indexOf(dateMatch[0])).trim()
        : lines;

    let name = 'Unknown';
    let address = '';

    // Strategy: Argentine names are 2-4 words. Streets always have a number (altura).
    // Find the first standalone number (2+ digits, the street number), then go back
    // to find where the address starts. The name is everything before.
    const words = beforeDate.split(/\s+/);
    let streetNumIndex = -1;
    for (let i = 0; i < words.length; i++) {
        if (/^\d{2,5}$/.test(words[i])) {
            streetNumIndex = i;
            break;
        }
    }

    if (streetNumIndex > 0) {
        // Argentine personal names: typically 2-3 words (first + optional middle + last)
        // The rest before the number is the street name
        // Heuristic: take the first 2 words if total words before number is 4+,
        // first 3 words if total is 5+, otherwise just first 2.
        const wordsBeforeNum = streetNumIndex;
        let nameWordCount = 2; // default: first + last
        if (wordsBeforeNum >= 5) nameWordCount = 3; // first + middle + last
        else if (wordsBeforeNum >= 4) nameWordCount = 3;
        else if (wordsBeforeNum === 3) nameWordCount = 2;

        // Ensure we don't take more words than available
        if (nameWordCount > wordsBeforeNum) nameWordCount = wordsBeforeNum;
        // Ensure at least 1 word for the street
        if (nameWordCount >= wordsBeforeNum) nameWordCount = wordsBeforeNum - 1;
        if (nameWordCount < 1) nameWordCount = 1;

        name = words.slice(0, nameWordCount).join(' ').trim();
        address = words.slice(nameWordCount).join(' ').trim();
    } else {
        name = beforeDate;
    }
    name = name || 'Unknown';
    // Clean up location info from address
    address = address.replace(/\s*\(\d{4}\)\s*.*/i, '').trim();

    // Extract Títulos Valorizados (total portfolio value)
    const titulosMatch = lines.match(/T[ií]tulos\s+Valorizados\s+AR\$\s+AR\$\s+([\d.,]+)/i) ||
        lines.match(/Títulos Valorizados.*?AR\$.*?([\d.,]+)/);

    // More robust: find "Títulos Valorizados" and then get the AR$ value after it
    let totalValue = 0;

    // Extract the values section: everything between the standard fields and the disclaimer
    const valuesSection = lines.match(
        /AR\$\s+AR\$\s+AR\$\s+US\$\s+US\$\s+AR\$\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/
    );

    let availablePesos = 0;
    let availablePesosOperable = 0;
    let caucionado = 0;
    let availableDolares = 0;
    let availableDolaresOperable = 0;

    if (valuesSection) {
        availablePesos = parseArgNumber(valuesSection[1]);
        availablePesosOperable = parseArgNumber(valuesSection[2]);
        caucionado = parseArgNumber(valuesSection[3]);
        availableDolares = parseArgNumber(valuesSection[4]);
        availableDolaresOperable = parseArgNumber(valuesSection[5]);
        totalValue = parseArgNumber(valuesSection[6]);
    }

    // Extract holdings (positions)
    // Pattern: Description TICKER BCBA Quantity AR$ Price Valuation
    const holdings = [];
    const holdingsRegex = /(?:Cedear|Bopreal|Bono|ON|Letra|FCI)\s+.+?\s+([A-Z0-9]+)\s+BCBA\s+([\d.,]+)\s+AR\$\s+([\d.,]+)\s+([\d.,]+)/gi;

    let match;
    const searchText = lines;
    // More flexible approach: find all ticker patterns after the header
    const afterDisclaimer = searchText.indexOf('disposición del cliente');
    if (afterDisclaimer > -1) {
        const holdingsText = searchText.substring(afterDisclaimer + 'disposición del cliente'.length).trim();

        // Split into blocks - each holding starts with a description
        // Pattern: "Description TICKER BCBA qty AR$ price valuation"
        const holdingPattern = /(.+?)\s+([A-Z][A-Z0-9]{1,6})\s+BCBA\s+([\d]+[,.]?[\d]*)\s+AR\$\s+([\d.,]+)\s+([\d.,]+)/g;

        let m;
        while ((m = holdingPattern.exec(holdingsText)) !== null) {
            const description = m[1].trim();
            const ticker = m[2];
            const quantity = parseArgNumber(m[3]);
            const price = parseArgNumber(m[4]);
            const valuation = parseArgNumber(m[5]);

            if (ticker && quantity > 0) {
                holdings.push({
                    description,
                    ticker,
                    market: 'BCBA',
                    quantity,
                    price,
                    valuation,
                });
            }
        }
    }

    // Extract total from "Saldo Total Títulos Val.: AR$ X"
    const totalMatch = lines.match(/Saldo Total.*?AR\$\s+([\d.,]+)/i);
    if (totalMatch) {
        totalValue = parseArgNumber(totalMatch[1]);
    }

    // IMPORTANT: Total portfolio value must include cash balances
    // availablePesos + availableDolares are part of the client's portfolio
    // The totalValue from IOL only counts "Títulos Valorizados" (securities)
    // We need to add cash to get the TRUE total
    const totalWithCash = totalValue + availablePesos;
    // Note: availableDolares is in USD, we store it separately
    // The conversion to ARS will be done at display time using exchange rates

    // Normalize date from dd/m/yyyy to YYYY-MM-DD for consistent comparison
    let normalizedDate = reportDate;
    if (reportDate) {
        const parts = reportDate.split('/');
        if (parts.length === 3) {
            const day = parts[0].padStart(2, '0');
            const month = parts[1].padStart(2, '0');
            const year = parts[2].length === 2 ? '20' + parts[2] : parts[2];
            normalizedDate = `${year}-${month}-${day}`;
        }
    }

    return {
        name,
        address,
        accountNumber,
        refNumber,
        date: normalizedDate,
        snapshot: {
            date: normalizedDate,
            totalValue: totalWithCash,
            securitiesValue: totalValue,
            availablePesos,
            availablePesosOperable,
            caucionado,
            availableDolares,
            availableDolaresOperable,
            holdings,
        },
    };
}

/**
 * Parser for IOL "Movimientos Históricos" XLS/HTML files
 */
export function parseMovimientosXLS(htmlContent) {
    // Extract period
    const periodMatch = htmlContent.match(/Operaciones Historicas del periodo (.+?) hasta (.+?)</);
    const periodStart = periodMatch ? periodMatch[1] : null;
    const periodEnd = periodMatch ? periodMatch[2] : null;

    // Parse rows
    const movements = [];
    const rowRegex = /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;

    let m;
    while ((m = rowRegex.exec(htmlContent)) !== null) {
        const movNumber = cleanHtml(m[1]).trim();
        // Skip header row
        if (movNumber === 'Nro. de Mov.' || !movNumber) continue;

        const tipoMov = cleanHtml(m[3]).trim();
        const concertDate = cleanHtml(m[4]).trim();
        const liquidDate = cleanHtml(m[5]).trim();
        const estado = cleanHtml(m[6]).trim();
        const cantidad = parseArgNumber(cleanHtml(m[7]).trim());
        const precio = parseArgNumber(cleanHtml(m[8]).trim());
        const comision = parseArgNumber(cleanHtml(m[9]).trim());
        const ivaComision = parseArgNumber(cleanHtml(m[10]).trim());
        const otrosImp = parseArgNumber(cleanHtml(m[11]).trim());
        const monto = parseArgNumber(cleanHtml(m[12]).trim());
        const observaciones = cleanHtml(m[13]).trim();
        const tipoCuenta = cleanHtml(m[14]).trim();

        // Classify movement type
        const classification = classifyMovement(tipoMov);

        movements.push({
            movNumber,
            boleto: cleanHtml(m[2]).trim(),
            tipoMov,
            concertDate: parseArgDate(concertDate),
            liquidDate: parseArgDate(liquidDate),
            estado,
            cantidad,
            precio,
            comision,
            ivaComision,
            otrosImp,
            monto,
            observaciones,
            tipoCuenta,
            moneda: tipoCuenta.includes('Dolares') ? 'USD' : 'ARS',
            classification,
            ticker: extractTicker(tipoMov),
        });
    }

    return { periodStart, periodEnd, movements };
}

/**
 * Classify a movement type
 */
function classifyMovement(tipoMov) {
    const lower = tipoMov.toLowerCase();

    if (lower.includes('depósito de fondos') || lower.includes('deposito de fondos')) {
        return 'DEPOSIT';
    }
    if (lower.includes('extracción de fondos') || lower.includes('extraccion de fondos')) {
        return 'WITHDRAWAL';
    }
    if (lower.startsWith('compra(') || lower.startsWith('compra (')) {
        return 'BUY';
    }
    if (lower.startsWith('venta(') || lower.startsWith('venta (')) {
        return 'SELL';
    }
    if (lower.includes('pago de dividendos')) {
        return 'DIVIDEND';
    }
    if (lower.includes('pago de renta')) {
        return 'COUPON';
    }
    if (lower.includes('crédito') || lower.includes('credito')) {
        return 'CREDIT';
    }
    if (lower.includes('pago de amortización') || lower.includes('amortizacion')) {
        return 'AMORTIZATION';
    }
    return 'OTHER';
}

/**
 * Extract ticker from movement type
 */
function extractTicker(tipoMov) {
    const match = tipoMov.match(/\((.+?)(?:\s+US\$)?\)/);
    return match ? match[1].trim() : null;
}

/**
 * Clean HTML entities and tags
 */
function cleanHtml(str) {
    return str
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&#233;/g, 'é')
        .replace(/&#243;/g, 'ó')
        .replace(/&#225;/g, 'á')
        .replace(/&#237;/g, 'í')
        .replace(/&#250;/g, 'ú')
        .replace(/&#241;/g, 'ñ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .trim();
}

/**
 * Parse Argentine number format (1.234,56 → 1234.56)
 */
function parseArgNumber(str) {
    if (!str || str.trim() === '') return 0;
    // Remove all spaces
    let clean = str.replace(/\s/g, '');
    // Remove color spans
    clean = clean.replace(/<[^>]*>/g, '');
    // Handle negative (sometimes with color:red span)
    const isNegative = clean.includes('-');
    clean = clean.replace(/-/g, '');
    // Argentine format: dots for thousands, comma for decimal
    clean = clean.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(clean);
    if (isNaN(num)) return 0;
    return isNegative ? -num : num;
}

/**
 * Parse Argentine date (dd/mm/yy or dd/mm/yyyy)
 */
function parseArgDate(str) {
    if (!str) return null;
    const parts = str.split('/');
    if (parts.length !== 3) return null;
    const day = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1;
    let year = parseInt(parts[2]);
    if (year < 100) year += 2000;
    return new Date(year, month, day).toISOString().split('T')[0];
}

/**
 * Get the exchange rate for a specific date from ratesHistory.
 * If exact date doesn't exist, finds the closest previous date.
 * Returns { mep: { compra, venta }, ccl: { compra, venta } } or null.
 */
export function getRateForDate(ratesHistory, dateStr) {
    if (!ratesHistory || Object.keys(ratesHistory).length === 0) return null;
    if (!dateStr) return null;
    if (ratesHistory[dateStr]) return ratesHistory[dateStr];

    const candidateDates = Object.keys(ratesHistory)
        .filter(date => date <= dateStr)
        .sort()
        .reverse();

    return candidateDates.length > 0 ? ratesHistory[candidateDates[0]] : null;
}

/** 
 * Extract MEP rate using the Midpoint (Promedio Compra/Venta)
 * This avoids the artificial spread distortion from pricing APIs.
 */
export function getMepRate(rate) {
    if (!rate) return null;
    const mep = rate.mep || {};
    // If it has both, calculate Midpoint
    if (mep.compra && mep.venta) {
        return (mep.compra + mep.venta) / 2;
    }
    // Fallbacks
    return mep.venta || mep.compra || rate.mepVenta || rate.mepCompra || null;
}

/**
 * Get total snapshot value in the measurement currency.
 * ARS: totalValue (ARS) + availableDolares * mepCompra
 * USD: totalValue / mepVenta + availableDolares
 */
function getSnapshotValueInCurrency(snapshot, currency, ratesHistory) {
    const arsValue = snapshot.totalValue || 0;
    const usdCash = snapshot.availableDolares || 0;
    if (currency === 'USD') {
        const rate = getRateForDate(ratesHistory, snapshot.date);
        const mepRate = getMepRate(rate) || 1;
        return mepRate > 0 ? (arsValue / mepRate) + usdCash : arsValue + usdCash;
    }
    // ARS mode
    const rate = getRateForDate(ratesHistory, snapshot.date);
    const mepRate = getMepRate(rate) || 1;
    return arsValue + (usdCash * mepRate);
}

/**
 * Convert a movement amount to the measurement currency.
 */
function getFlowAmountInCurrency(flow, currency, ratesHistory) {
    const amount = Math.abs(flow.monto);
    const flowDate = flow.concertDate;
    if (flow.moneda === 'ARS' && currency === 'USD') {
        const rate = getRateForDate(ratesHistory, flowDate);
        const mepRate = getMepRate(rate) || 1;
        return mepRate > 0 ? amount / mepRate : amount;
    }
    if (flow.moneda === 'USD' && currency !== 'USD') {
        const rate = getRateForDate(ratesHistory, flowDate);
        const mepRate = getMepRate(rate) || 1;
        return amount * mepRate;
    }
    return amount;
}

/**
 * Calculate complete performance metrics for a client.
 * Uses manualFlows (user-entered external cash flows in USD) for XIRR.
 * manualFlows = [{ date, amount }] where amount > 0 = deposit, < 0 = withdrawal
 */
export function calculatePerformance(snapshots, movements, ratesHistory = {}, currency = 'ARS', manualFlows = []) {
    const result = {
        totalReturn: null,
        annualizedTIR: null,
        ytdReturn: null,
        prevYearReturn: null,
        startDate: null,
        endDate: null,
    };

    if (snapshots.length < 2) return result;

    const sorted = [...snapshots].sort((a, b) => new Date(a.date) - new Date(b.date));
    const firstSnapshot = sorted[0];
    const lastSnapshot = sorted[sorted.length - 1];

    result.startDate = firstSnapshot.date;
    result.endDate = lastSnapshot.date;

    // XIRR between two snapshots using manual flows
    function xirrBetween(snapA, snapB) {
        const dA = new Date(snapA.date);
        const dB = new Date(snapB.date);
        const days = (dB - dA) / (1000 * 60 * 60 * 24);
        if (days <= 0) return 0;

        const vA = getSnapshotValueInCurrency(snapA, currency, ratesHistory);
        const vB = getSnapshotValueInCurrency(snapB, currency, ratesHistory);

        const flowsInRange = (manualFlows || []).filter(f => f.date > snapA.date && f.date < snapB.date);

        if (flowsInRange.length === 0) {
            if (vA === 0) return 0;
            return Math.pow(vB / vA, 365.25 / days) - 1;
        }

        // Convert flow amount to target currency using MEP rate
        function convertFlow(flow) {
            const flowCurrency = flow.currency || 'USD';
            if (flowCurrency === currency) return flow.amount; // Same currency, no conversion

            const rate = getMepRate(getRateForDate(ratesHistory, flow.date));
            if (!rate || rate <= 0) return flow.amount; // No rate available, use as-is

            if (flowCurrency === 'ARS' && (currency === 'USD' || currency === 'USD_CCL')) {
                return flow.amount / rate; // ARS → USD
            }
            if (flowCurrency === 'USD' && currency === 'ARS') {
                return flow.amount * rate; // USD → ARS
            }
            return flow.amount;
        }

        // Build cash flows: negative = invested, positive = received
        const cashFlows = [{ amount: -vA, date: dA }];
        for (const f of flowsInRange) {
            const converted = convertFlow(f);
            cashFlows.push({ amount: -converted, date: new Date(f.date) });
        }
        cashFlows.push({ amount: vB, date: dB });

        // DEBUG: Consolidated single log to avoid Next.js forwarding dropping lines
        const _debugFlows = flowsInRange.map(f => {
            const converted = convertFlow(f);
            const rateLookup = getMepRate(getRateForDate(ratesHistory, f.date));
            return `${f.date} | amt:${f.amount} | cur:${f.currency || 'USD'} | rate:${rateLookup} | conv:${converted.toFixed(2)}`;
        });
        const _debugCF = cashFlows.map(cf => `${cf.date.toISOString().split('T')[0]} | ${cf.amount.toFixed(2)}`);

        const xirr = calculateXIRR(cashFlows);
        console.log(`XIRR_DEBUG | ${snapA.date}→${snapB.date} | cur:${currency} | vA:${vA.toFixed(2)} | vB:${vB.toFixed(2)} | flows:${flowsInRange.length} | [${_debugFlows.join(' // ')}] | CF:[${_debugCF.join(' // ')}] | XIRR:${xirr !== null ? (xirr * 100).toFixed(4) + '%' : 'null'}`);
        if (xirr !== null) return xirr;

        // Fallback: Modified Dietz (annualized)
        let wf = 0, tf = 0;
        for (const f of flowsInRange) {
            const converted = convertFlow(f);
            const d = (new Date(f.date) - dA) / (1000 * 60 * 60 * 24);
            const w = 1 - (d / days);
            wf += (-converted) * w;
            tf += (-converted);
        }
        if (vA - wf === 0) return 0;
        const dietz = (vB - vA + tf) / (vA - wf);
        return Math.pow(1 + dietz, 365.25 / days) - 1;
    }

    // 1. TIR Anualizada (full period)
    result.annualizedTIR = xirrBetween(firstSnapshot, lastSnapshot);

    // 2. TIR Total
    if (result.annualizedTIR !== null) {
        const days = (new Date(lastSnapshot.date) - new Date(firstSnapshot.date)) / (1000 * 60 * 60 * 24);
        result.totalReturn = Math.pow(1 + result.annualizedTIR, days / 365.25) - 1;
    }

    function findOnOrBefore(dateStr) {
        for (let i = sorted.length - 1; i >= 0; i--) { if (sorted[i].date <= dateStr) return sorted[i]; }
        return null;
    }
    function findOnOrAfter(dateStr) {
        for (let i = 0; i < sorted.length; i++) { if (sorted[i].date >= dateStr) return sorted[i]; }
        return null;
    }

    const yr = new Date().getFullYear();
    const jan1 = `${yr}-01-01`;

    // 3. TIR YTD
    const ytdS = findOnOrBefore(jan1) || findOnOrAfter(jan1);
    if (ytdS && ytdS !== lastSnapshot) {
        const a = xirrBetween(ytdS, lastSnapshot);
        if (a !== null) {
            const d = (new Date(lastSnapshot.date) - new Date(ytdS.date)) / (1000 * 60 * 60 * 24);
            result.ytdReturn = Math.pow(1 + a, d / 365.25) - 1;
        }
    }

    // 4. TIR Año Anterior
    const jan1Prev = `${yr - 1}-01-01`;
    const pS = findOnOrBefore(jan1Prev) || findOnOrAfter(jan1Prev);
    const pE = findOnOrBefore(jan1);
    if (pS && pE && pS !== pE) {
        const a = xirrBetween(pS, pE);
        if (a !== null) {
            const d = (new Date(pE.date) - new Date(pS.date)) / (1000 * 60 * 60 * 24);
            result.prevYearReturn = Math.pow(1 + a, d / 365.25) - 1;
        }
    }

    return result;
}

/**
 * Compute XIRR between two snapshots (currency-aware).
 * ALWAYS returns an ANNUALIZED rate for consistency.
 */
function computeXIRRForRange(startSnap, endSnap, movements, ratesHistory, currency) {
    const startDate = new Date(startSnap.date);
    const endDate = new Date(endSnap.date);
    const totalDays = (endDate - startDate) / (1000 * 60 * 60 * 24);
    if (totalDays <= 0) return 0;

    const startValue = getSnapshotValueInCurrency(startSnap, currency, ratesHistory);
    const endValue = getSnapshotValueInCurrency(endSnap, currency, ratesHistory);

    const externalFlows = movements
        .filter(m => m.classification === 'DEPOSIT' || m.classification === 'WITHDRAWAL')
        .filter(m => {
            const mDate = new Date(m.concertDate);
            return mDate >= startDate && mDate <= endDate;
        })
        .sort((a, b) => new Date(a.concertDate) - new Date(b.concertDate));

    if (externalFlows.length === 0) {
        // No external flows — simple return, ANNUALIZED
        if (startValue === 0) return 0;
        const periodReturn = (endValue / startValue) - 1;
        const years = totalDays / 365.25;
        // Annualize: (1 + periodReturn)^(1/years) - 1
        return Math.pow(1 + periodReturn, 1 / years) - 1;
    }

    const cashFlows = [];
    cashFlows.push({ amount: -startValue, date: startDate });

    for (const flow of externalFlows) {
        const flowDate = new Date(flow.concertDate);
        const converted = getFlowAmountInCurrency(flow, currency, ratesHistory);
        if (flow.classification === 'DEPOSIT') {
            cashFlows.push({ amount: -converted, date: flowDate });
        } else {
            cashFlows.push({ amount: converted, date: flowDate });
        }
    }

    cashFlows.push({ amount: endValue, date: endDate });

    // DEBUG: Print all cash flows for comparison with Excel
    console.log('=== XIRR DEBUG ===');
    console.log(`Period: ${startSnap.date} → ${endSnap.date} | Currency: ${currency}`);
    console.log(`Start Value: ${startValue.toFixed(2)} | End Value: ${endValue.toFixed(2)}`);
    console.log(`External flows (${externalFlows.length}):`);
    for (const f of externalFlows) {
        const converted = getFlowAmountInCurrency(f, currency, ratesHistory);
        console.log(`  ${f.concertDate} | ${f.classification} | ${f.tipoMov} | moneda: ${f.moneda} | monto: ${f.monto} | converted: ${converted.toFixed(2)}`);
    }
    console.log('Cash flows for XIRR:');
    for (const cf of cashFlows) {
        console.log(`  ${cf.date.toISOString().split('T')[0]} | ${cf.amount.toFixed(2)}`);
    }

    const xirr = calculateXIRR(cashFlows);
    if (xirr !== null) return xirr;

    // Fallback: Modified Dietz
    let weightedFlows = 0, totalFlowsSum = 0;
    for (const flow of externalFlows) {
        const daysFromStart = (new Date(flow.concertDate) - startDate) / (1000 * 60 * 60 * 24);
        const weight = 1 - (daysFromStart / totalDays);
        const converted = getFlowAmountInCurrency(flow, currency, ratesHistory);
        const signed = flow.classification === 'DEPOSIT' ? converted : -converted;
        weightedFlows += signed * weight;
        totalFlowsSum += signed;
    }
    if (startValue + weightedFlows === 0) return 0;
    return (endValue - startValue - totalFlowsSum) / (startValue + weightedFlows);
}

/**
 * Backward-compatible wrapper. Returns the annualized TIR or null.
 */
export function calculateTWR(snapshots, movements) {
    const perf = calculatePerformance(snapshots, movements);
    return perf.annualizedTIR;
}

/**
 * XIRR calculation using Newton-Raphson method.
 * Finds the annualized rate r such that:
 *   sum( cashFlow_i / (1+r)^(days_i/365.25) ) = 0
 * 
 * @param {Array} cashFlows - [{amount, date}, ...]
 * @returns {number|null} annualized rate, or null if doesn't converge
 */
function calculateXIRR(cashFlows) {
    if (cashFlows.length < 2) return null;

    const baseDate = cashFlows[0].date;

    // NPV function
    function npv(rate) {
        let sum = 0;
        for (const cf of cashFlows) {
            const days = (cf.date - baseDate) / (1000 * 60 * 60 * 24);
            const years = days / 365.25;
            sum += cf.amount / Math.pow(1 + rate, years);
        }
        return sum;
    }

    // Derivative of NPV
    function npvDerivative(rate) {
        let sum = 0;
        for (const cf of cashFlows) {
            const days = (cf.date - baseDate) / (1000 * 60 * 60 * 24);
            const years = days / 365.25;
            if (years === 0) continue;
            sum -= years * cf.amount / Math.pow(1 + rate, years + 1);
        }
        return sum;
    }

    // Newton-Raphson iteration
    let rate = 0.1; // Initial guess: 10%
    const maxIterations = 100;
    const tolerance = 1e-7;

    for (let i = 0; i < maxIterations; i++) {
        const fVal = npv(rate);
        const fDeriv = npvDerivative(rate);

        if (Math.abs(fDeriv) < 1e-12) break; // Derivative too small

        const newRate = rate - fVal / fDeriv;

        // Guard against divergence
        if (newRate < -0.99) {
            rate = -0.99;
            continue;
        }
        if (newRate > 100) {
            rate = 100;
            continue;
        }

        if (Math.abs(newRate - rate) < tolerance) {
            return newRate;
        }
        rate = newRate;
    }

    // Try with different initial guesses if first attempt failed
    for (const guess of [0.0, -0.5, 0.5, 1.0, 2.0]) {
        rate = guess;
        for (let i = 0; i < maxIterations; i++) {
            const fVal = npv(rate);
            const fDeriv = npvDerivative(rate);
            if (Math.abs(fDeriv) < 1e-12) break;
            const newRate = rate - fVal / fDeriv;
            if (newRate < -0.99) { rate = -0.99; continue; }
            if (newRate > 100) { rate = 100; continue; }
            if (Math.abs(newRate - rate) < tolerance) return newRate;
            rate = newRate;
        }
    }

    return null; // Failed to converge
}

/**
 * Get total deposits for a client, separated by currency
 */
export function getTotalDeposits(movements) {
    const ars = movements
        .filter(m => m.classification === 'DEPOSIT' && m.moneda === 'ARS')
        .reduce((sum, m) => sum + Math.abs(m.monto), 0);
    const usd = movements
        .filter(m => m.classification === 'DEPOSIT' && m.moneda === 'USD')
        .reduce((sum, m) => sum + Math.abs(m.monto), 0);
    return { ars, usd };
}

/**
 * Get total withdrawals for a client, separated by currency
 */
export function getTotalWithdrawals(movements) {
    const ars = movements
        .filter(m => m.classification === 'WITHDRAWAL' && m.moneda === 'ARS')
        .reduce((sum, m) => sum + Math.abs(m.monto), 0);
    const usd = movements
        .filter(m => m.classification === 'WITHDRAWAL' && m.moneda === 'USD')
        .reduce((sum, m) => sum + Math.abs(m.monto), 0);
    return { ars, usd };
}

/**
 * Format number as Argentine currency
 */
export function formatCurrency(value, currency = 'ARS') {
    if (value === null || value === undefined || isNaN(value)) return '-';
    const prefix = currency === 'ARS' ? '$ ' : 'US$ ';
    const absVal = Math.abs(value);
    const formatted = absVal.toLocaleString('es-AR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return (value < 0 ? '-' : '') + prefix + formatted;
}

/**
 * Format percentage
 */
export function formatPercent(value) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    const sign = value >= 0 ? '+' : '';
    return sign + (value * 100).toFixed(2) + '%';
}
