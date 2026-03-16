// SERVER-SIDE API Route for IOL
// Credentials never leave the server.
// Request counter persisted in Supabase.

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const IOL_API_URL = process.env.IOL_API_URL || 'https://api.invertironline.com';
const IOL_USERNAME = process.env.IOL_USERNAME;
const IOL_PASSWORD = process.env.IOL_PASSWORD;

// Server-side Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServer = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// In-memory token cache
let tokenCache = {
    accessToken: null,
    refreshToken: null,
    expiresAt: 0,
};

// Fallback in-memory counter (used if Supabase fails)
let memoryCounter = { count: 0, month: new Date().getMonth() + 1, year: new Date().getFullYear() };

function normalizeDate(dateValue) {
    if (!dateValue) return null;
    if (typeof dateValue === 'string') {
        const isoMatch = dateValue.match(/^(\d{4}-\d{2}-\d{2})/);
        if (isoMatch) return isoMatch[1];

        const argMatch = dateValue.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (argMatch) {
            const [, day, month, year] = argMatch;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }
    }

    const parsed = new Date(dateValue);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().split('T')[0];
}

function extractHistoricalPrice(entry) {
    const candidates = [
        entry?.ultimoPrecio,
        entry?.precioUltimo,
        entry?.precioCierre,
        entry?.cierre,
        entry?.ultimo,
        entry?.close,
        entry?.precio,
    ];

    for (const candidate of candidates) {
        const parsed = Number(candidate);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    return null;
}

function seriesToPriceMap(rawSeries) {
    const items = Array.isArray(rawSeries)
        ? rawSeries
        : Array.isArray(rawSeries?.data)
            ? rawSeries.data
            : Array.isArray(rawSeries?.serie)
                ? rawSeries.serie
                : [];

    const priceMap = {};
    for (const item of items) {
        const date = normalizeDate(item?.fechaHora ?? item?.fecha ?? item?.date);
        const price = extractHistoricalPrice(item);
        if (date && price) {
            priceMap[date] = price;
        }
    }
    return priceMap;
}

/**
 * Get counter from Supabase. Returns count or 0 on error.
 */
async function getCounterFromDb() {
    if (!supabaseServer) return memoryCounter.count;
    try {
        const { data, error } = await supabaseServer
            .from('iol_request_counter')
            .select('count, month, year')
            .eq('id', 1)
            .maybeSingle();

        if (error) {
            console.error('DB read error:', error.message);
            return memoryCounter.count;
        }
        if (!data) {
            console.error('No counter row found');
            return memoryCounter.count;
        }

        const now = new Date();
        const currentMonth = now.getMonth() + 1;
        const currentYear = now.getFullYear();

        // Reset if month changed
        if (data.month !== currentMonth || data.year !== currentYear) {
            const { error: updateErr } = await supabaseServer
                .from('iol_request_counter')
                .update({ count: 0, month: currentMonth, year: currentYear })
                .eq('id', 1);
            if (updateErr) console.error('DB reset error:', updateErr.message);
            memoryCounter = { count: 0, month: currentMonth, year: currentYear };
            return 0;
        }

        memoryCounter.count = data.count;
        return data.count;
    } catch (e) {
        console.error('Counter read exception:', e.message);
        return memoryCounter.count;
    }
}

/**
 * Add N to the counter in Supabase.
 */
async function addToCounter(n) {
    // Always update memory counter
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    if (memoryCounter.month !== currentMonth || memoryCounter.year !== currentYear) {
        memoryCounter = { count: 0, month: currentMonth, year: currentYear };
    }
    memoryCounter.count += n;

    if (!supabaseServer) return memoryCounter.count;

    try {
        // Read current value
        const { data, error: readErr } = await supabaseServer
            .from('iol_request_counter')
            .select('count, month, year')
            .eq('id', 1)
            .maybeSingle();

        if (readErr) {
            console.error('DB increment read error:', readErr.message);
            return memoryCounter.count;
        }

        let newCount = n;
        if (data && data.month === currentMonth && data.year === currentYear) {
            newCount = (data.count || 0) + n;
        }

        // Write new value
        const { error: writeErr } = await supabaseServer
            .from('iol_request_counter')
            .update({ count: newCount, month: currentMonth, year: currentYear })
            .eq('id', 1);

        if (writeErr) {
            console.error('DB increment write error:', writeErr.message);
            // Try upsert instead
            const { error: upsertErr } = await supabaseServer
                .from('iol_request_counter')
                .upsert({ id: 1, count: newCount, month: currentMonth, year: currentYear });
            if (upsertErr) console.error('DB upsert error:', upsertErr.message);
        }

        memoryCounter.count = newCount;
        return newCount;
    } catch (e) {
        console.error('Counter increment exception:', e.message);
        return memoryCounter.count;
    }
}

/**
 * Authenticate with IOL API and get bearer token
 */
async function getToken() {
    if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) {
        return { token: tokenCache.accessToken, requestsUsed: 0 };
    }

    if (tokenCache.refreshToken) {
        try {
            const refreshRes = await fetch(`${IOL_API_URL}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: tokenCache.refreshToken,
                }).toString(),
            });
            if (refreshRes.ok) {
                const data = await refreshRes.json();
                tokenCache = {
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token,
                    expiresAt: Date.now() + (data.expires_in || 900) * 1000,
                };
                return { token: tokenCache.accessToken, requestsUsed: 1 };
            }
        } catch (e) {
            console.error('Refresh token failed:', e.message);
        }
    }

    const loginRes = await fetch(`${IOL_API_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            username: IOL_USERNAME,
            password: IOL_PASSWORD,
            grant_type: 'password',
        }).toString(),
    });

    if (!loginRes.ok) {
        const errText = await loginRes.text();
        throw new Error(`IOL Login failed (${loginRes.status}): ${errText}`);
    }

    const data = await loginRes.json();
    tokenCache = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in || 900) * 1000,
    };
    return { token: tokenCache.accessToken, requestsUsed: 1 };
}

/**
 * Make an authenticated GET to IOL (with auto-retry on 401)
 */
async function iolGet(endpoint) {
    const { token, requestsUsed: authReqs } = await getToken();
    let res = await fetch(`${IOL_API_URL}${endpoint}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
    });

    let totalReqs = authReqs + 1;

    // If 401, clear token cache and retry with fresh login
    if (res.status === 401) {
        console.log('Got 401, clearing token cache and retrying...');
        tokenCache = { accessToken: null, refreshToken: null, expiresAt: 0 };
        const { token: newToken, requestsUsed: retryAuthReqs } = await getToken();
        res = await fetch(`${IOL_API_URL}${endpoint}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${newToken}` },
        });
        totalReqs += retryAuthReqs + 1;
    }

    const newTotal = await addToCounter(totalReqs);

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`IOL API error (${res.status}): ${errText}`);
    }


    return { data: await res.json(), dbCount: newTotal };
}

export async function POST(request) {
    try {
        if (!IOL_USERNAME || !IOL_PASSWORD) {
            return NextResponse.json(
                { error: 'IOL credentials not configured on server' },
                { status: 500 }
            );
        }

        const body = await request.json();
        const { action, params } = body;

        let result;
        let currentCount;

        switch (action) {
            case 'test_connection': {
                const { requestsUsed } = await getToken();
                if (requestsUsed > 0) await addToCounter(requestsUsed);
                currentCount = await getCounterFromDb();
                result = { ok: true, message: 'Conexión exitosa con IOL API' };
                break;
            }

            case 'panel_bonos': {
                // IOL uses "titulosPublicos" for government bonds
                const r = await iolGet('/api/v2/Cotizaciones/titulosPublicos/argentina/Todos');
                result = r.data;
                currentCount = r.dbCount;
                break;
            }

            case 'panel_acciones': {
                const r = await iolGet('/api/v2/Cotizaciones/acciones/argentina/Todos');
                result = r.data;
                currentCount = r.dbCount;
                break;
            }

            case 'panel_cedears': {
                const r = await iolGet('/api/v2/Cotizaciones/cedears/argentina/Todos');
                result = r.data;
                currentCount = r.dbCount;
                break;
            }

            case 'panel_letras': {
                const r = await iolGet('/api/v2/Cotizaciones/Letras/argentina/Todos');
                result = r.data;
                currentCount = r.dbCount;
                break;
            }

            case 'panel_obligaciones': {
                const r = await iolGet('/api/v2/Cotizaciones/obligacionesNegociables/argentina/Todos');
                result = r.data;
                currentCount = r.dbCount;
                break;
            }

            case 'cotizacion_titulo': {
                const { mercado = 'bCBA', simbolo } = params || {};
                if (!simbolo) throw new Error('Falta el símbolo del título');
                const r = await iolGet(`/api/v2/${mercado}/Titulos/${simbolo}/Cotizacion`);
                result = r.data;
                currentCount = r.dbCount;
                break;
            }

            case 'serie_historica': {
                const { mercado: mkt = 'bCBA', simbolo: sym, desde, hasta, ajustada = 'sinAjustar' } = params || {};
                if (!sym || !desde || !hasta) throw new Error('Faltan parámetros (simbolo, desde, hasta)');
                const r = await iolGet(`/api/v2/${mkt}/Titulos/${sym}/Cotizacion/seriehistorica/${desde}/${hasta}/${ajustada}`);
                result = r.data;
                currentCount = r.dbCount;
                break;
            }

            case 'historical_mep': {
                const { mercado: mkt = 'bCBA', bonoPesos = 'AL30', bonoDolares = 'AL30D', desde, hasta, ajustada = 'sinAjustar' } = params || {};
                if (!desde || !hasta) throw new Error('Faltan parámetros (desde, hasta)');

                const [arsSeries, usdSeries] = await Promise.all([
                    iolGet(`/api/v2/${mkt}/Titulos/${bonoPesos}/Cotizacion/seriehistorica/${desde}/${hasta}/${ajustada}`),
                    iolGet(`/api/v2/${mkt}/Titulos/${bonoDolares}/Cotizacion/seriehistorica/${desde}/${hasta}/${ajustada}`),
                ]);

                const arsByDate = seriesToPriceMap(arsSeries.data);
                const usdByDate = seriesToPriceMap(usdSeries.data);
                const allDates = [...new Set([...Object.keys(arsByDate), ...Object.keys(usdByDate)])].sort();
                const ratesByDate = {};

                let lastArsPrice = null;
                let lastUsdPrice = null;

                for (const date of allDates) {
                    if (arsByDate[date]) lastArsPrice = arsByDate[date];
                    if (usdByDate[date]) lastUsdPrice = usdByDate[date];

                    if (!lastArsPrice || !lastUsdPrice) continue;

                    const mep = lastArsPrice / lastUsdPrice;
                    if (!Number.isFinite(mep) || mep <= 0) continue;

                    ratesByDate[date] = {
                        mep: { compra: mep, venta: mep },
                        source: 'iol_al30_mep',
                        isDerived: true,
                        meta: {
                            bonoPesos,
                            bonoDolares,
                            arsPrice: lastArsPrice,
                            usdPrice: lastUsdPrice,
                        },
                    };
                }

                result = {
                    from: desde,
                    to: hasta,
                    ratesByDate,
                    dates: Object.keys(ratesByDate),
                };
                currentCount = Math.max(arsSeries.dbCount, usdSeries.dbCount);
                break;
            }

            case 'estado_cuenta': {
                const r = await iolGet('/api/v2/estadocuenta');
                result = r.data;
                currentCount = r.dbCount;
                break;
            }

            case 'portafolio': {
                const r = await iolGet('/api/v2/portafolio/argentina');
                result = r.data;
                currentCount = r.dbCount;
                break;
            }

            case 'get_request_count': {
                currentCount = await getCounterFromDb();
                result = {
                    count: currentCount,
                    limit: 20000,
                    remaining: 20000 - currentCount,
                };
                break;
            }

            default:
                return NextResponse.json({ error: `Acción desconocida: ${action}` }, { status: 400 });
        }

        if (currentCount === undefined) {
            currentCount = await getCounterFromDb();
        }

        return NextResponse.json({
            data: result,
            requestCount: currentCount,
            requestLimit: 20000,
        });

    } catch (err) {
        console.error('IOL API Route Error:', err);
        const count = memoryCounter.count;
        return NextResponse.json(
            { error: err.message || 'Error interno del servidor', requestCount: count, requestLimit: 20000 },
            { status: 500 }
        );
    }
}
