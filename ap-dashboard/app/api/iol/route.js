// SERVER-SIDE API Route for IOL
// Credentials never leave the server.
// Request counter persisted in Supabase.

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const IOL_API_URL = process.env.IOL_API_URL || 'https://api.invertironline.com';
const IOL_USERNAME = process.env.IOL_USERNAME;
const IOL_PASSWORD = process.env.IOL_PASSWORD;

// Server-side Supabase client (uses service-level access via anon key for counter)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServer = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// In-memory token cache (lives as long as the serverless function is warm)
let tokenCache = {
    accessToken: null,
    refreshToken: null,
    expiresAt: 0,
};

/**
 * Get the current request count from Supabase
 */
async function getDbRequestCount() {
    if (!supabaseServer) return 0;
    try {
        const now = new Date();
        const currentMonth = now.getMonth() + 1; // 1-indexed
        const currentYear = now.getFullYear();

        const { data, error } = await supabaseServer
            .from('iol_request_counter')
            .select('*')
            .eq('id', 1)
            .single();

        if (error || !data) return 0;

        // If month/year changed, reset
        if (data.month !== currentMonth || data.year !== currentYear) {
            await supabaseServer
                .from('iol_request_counter')
                .update({ count: 0, month: currentMonth, year: currentYear })
                .eq('id', 1);
            return 0;
        }

        return data.count || 0;
    } catch (e) {
        console.error('Failed to read request counter:', e);
        return 0;
    }
}

/**
 * Increment the request counter in Supabase by N
 */
async function incrementDbRequestCount(n = 1) {
    if (!supabaseServer) return 0;
    try {
        const now = new Date();
        const currentMonth = now.getMonth() + 1;
        const currentYear = now.getFullYear();

        // Read current
        const { data } = await supabaseServer
            .from('iol_request_counter')
            .select('*')
            .eq('id', 1)
            .single();

        let newCount = n;
        if (data) {
            if (data.month === currentMonth && data.year === currentYear) {
                newCount = (data.count || 0) + n;
            }
        }

        await supabaseServer
            .from('iol_request_counter')
            .upsert({ id: 1, count: newCount, month: currentMonth, year: currentYear });

        return newCount;
    } catch (e) {
        console.error('Failed to update request counter:', e);
        return 0;
    }
}

/**
 * Authenticate with IOL API and get bearer token
 */
async function getToken() {
    // Check if we have a valid cached token (with 60s buffer)
    if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) {
        return { token: tokenCache.accessToken, newRequests: 0 };
    }

    // Try refresh token first
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
                return { token: tokenCache.accessToken, newRequests: 1 };
            }
        } catch (e) {
            console.error('Refresh token failed, will re-login', e);
        }
    }

    // Full login
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
    return { token: tokenCache.accessToken, newRequests: 1 };
}

/**
 * Make an authenticated GET request to IOL API
 * Returns { data, requestsUsed } to track total requests per call
 */
async function iolGet(endpoint) {
    const { token, newRequests: authRequests } = await getToken();
    const res = await fetch(`${IOL_API_URL}${endpoint}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
        },
    });

    const totalNewRequests = authRequests + 1; // +1 for this GET

    if (!res.ok) {
        // Still count the failed request
        await incrementDbRequestCount(totalNewRequests);
        const errText = await res.text();
        throw new Error(`IOL API error (${res.status}): ${errText}`);
    }

    // Persist count to DB
    const newTotal = await incrementDbRequestCount(totalNewRequests);

    const jsonData = await res.json();
    return { data: jsonData, dbCount: newTotal };
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
                const { newRequests } = await getToken();
                if (newRequests > 0) await incrementDbRequestCount(newRequests);
                currentCount = await getDbRequestCount();
                result = { ok: true, message: 'Conexión exitosa con IOL API' };
                break;
            }

            case 'panel_bonos': {
                const r = await iolGet('/api/v2/Cotizaciones/bonos/argentina/Todos');
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
                const r = await iolGet('/api/v2/Cotizaciones/letrasDelTesoro/argentina/Todos');
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
                const { mercado: mkt = 'bCBA', simbolo: sym, desde, hasta, ajustada = 'ajustada' } = params || {};
                if (!sym || !desde || !hasta) throw new Error('Faltan parámetros (simbolo, desde, hasta)');
                const r = await iolGet(`/api/v2/${mkt}/Titulos/${sym}/Cotizacion/seriehistorica/${desde}/${hasta}/${ajustada}`);
                result = r.data;
                currentCount = r.dbCount;
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
                currentCount = await getDbRequestCount();
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

        // If we haven't read the count yet, get it now
        if (currentCount === undefined) {
            currentCount = await getDbRequestCount();
        }

        return NextResponse.json({
            data: result,
            requestCount: currentCount,
            requestLimit: 20000,
        });

    } catch (err) {
        console.error('IOL API Route Error:', err);
        const count = await getDbRequestCount();
        return NextResponse.json(
            { error: err.message || 'Error interno del servidor', requestCount: count, requestLimit: 20000 },
            { status: 500 }
        );
    }
}
