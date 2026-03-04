// SERVER-SIDE API Route for IOL
// Credentials never leave the server.

import { NextResponse } from 'next/server';

const IOL_API_URL = process.env.IOL_API_URL || 'https://api.invertironline.com';
const IOL_USERNAME = process.env.IOL_USERNAME;
const IOL_PASSWORD = process.env.IOL_PASSWORD;

// In-memory token cache (lives as long as the serverless function is warm)
let tokenCache = {
    accessToken: null,
    refreshToken: null,
    expiresAt: 0, // timestamp
};

// Monthly request counter (in-memory, resets on cold start)
// For persistent tracking, we'll use Supabase later
let requestCounter = {
    count: 0,
    month: new Date().getMonth(),
    year: new Date().getFullYear(),
};

function incrementRequestCount() {
    const now = new Date();
    if (now.getMonth() !== requestCounter.month || now.getFullYear() !== requestCounter.year) {
        requestCounter = { count: 0, month: now.getMonth(), year: now.getFullYear() };
    }
    requestCounter.count++;
    return requestCounter.count;
}

function getRequestCount() {
    const now = new Date();
    if (now.getMonth() !== requestCounter.month || now.getFullYear() !== requestCounter.year) {
        requestCounter = { count: 0, month: now.getMonth(), year: now.getFullYear() };
    }
    return requestCounter.count;
}

/**
 * Authenticate with IOL API and get bearer token
 */
async function getToken() {
    // Check if we have a valid cached token (with 60s buffer)
    if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) {
        return tokenCache.accessToken;
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
                incrementRequestCount();
                return tokenCache.accessToken;
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
    incrementRequestCount();
    return tokenCache.accessToken;
}

/**
 * Make an authenticated GET request to IOL API
 */
async function iolGet(endpoint) {
    const token = await getToken();
    const res = await fetch(`${IOL_API_URL}${endpoint}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
        },
    });
    incrementRequestCount();

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`IOL API error (${res.status}): ${errText}`);
    }

    return res.json();
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

        switch (action) {
            case 'test_connection': {
                // Just try to get a token
                await getToken();
                result = { ok: true, message: 'Conexión exitosa con IOL API' };
                break;
            }

            case 'panel_bonos': {
                // GET /api/v2/Cotizaciones/bonos/argentina/Todos
                result = await iolGet('/api/v2/Cotizaciones/bonos/argentina/Todos');
                break;
            }

            case 'panel_acciones': {
                // GET /api/v2/Cotizaciones/acciones/argentina/Todos
                result = await iolGet('/api/v2/Cotizaciones/acciones/argentina/Todos');
                break;
            }

            case 'panel_cedears': {
                // GET /api/v2/Cotizaciones/cedears/argentina/Todos
                result = await iolGet('/api/v2/Cotizaciones/cedears/argentina/Todos');
                break;
            }

            case 'panel_letras': {
                // GET /api/v2/Cotizaciones/letrasDelTesoro/argentina/Todos
                result = await iolGet('/api/v2/Cotizaciones/letrasDelTesoro/argentina/Todos');
                break;
            }

            case 'panel_obligaciones': {
                // GET /api/v2/Cotizaciones/obligacionesNegociables/argentina/Todos
                result = await iolGet('/api/v2/Cotizaciones/obligacionesNegociables/argentina/Todos');
                break;
            }

            case 'cotizacion_titulo': {
                // GET /api/v2/{mercado}/Titulos/{simbolo}/Cotizacion
                const { mercado = 'bCBA', simbolo } = params || {};
                if (!simbolo) throw new Error('Falta el símbolo del título');
                result = await iolGet(`/api/v2/${mercado}/Titulos/${simbolo}/Cotizacion`);
                break;
            }

            case 'serie_historica': {
                // GET /api/v2/{mercado}/Titulos/{simbolo}/Cotizacion/seriehistorica/{desde}/{hasta}/ajustada
                const { mercado: mkt = 'bCBA', simbolo: sym, desde, hasta, ajustada = 'ajustada' } = params || {};
                if (!sym || !desde || !hasta) throw new Error('Faltan parámetros (simbolo, desde, hasta)');
                result = await iolGet(`/api/v2/${mkt}/Titulos/${sym}/Cotizacion/seriehistorica/${desde}/${hasta}/${ajustada}`);
                break;
            }

            case 'estado_cuenta': {
                // GET /api/v2/estadocuenta
                result = await iolGet('/api/v2/estadocuenta');
                break;
            }

            case 'portafolio': {
                // GET /api/v2/portafolio/argentina
                result = await iolGet('/api/v2/portafolio/argentina');
                break;
            }

            case 'get_request_count': {
                result = {
                    count: getRequestCount(),
                    month: requestCounter.month + 1,
                    year: requestCounter.year,
                    limit: 20000,
                    remaining: 20000 - getRequestCount(),
                };
                break;
            }

            default:
                return NextResponse.json({ error: `Acción desconocida: ${action}` }, { status: 400 });
        }

        return NextResponse.json({
            data: result,
            requestCount: getRequestCount(),
            requestLimit: 20000,
        });

    } catch (err) {
        console.error('IOL API Route Error:', err);
        return NextResponse.json(
            { error: err.message || 'Error interno del servidor' },
            { status: 500 }
        );
    }
}
