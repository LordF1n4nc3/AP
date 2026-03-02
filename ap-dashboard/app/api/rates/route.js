import { NextResponse } from 'next/server';

/**
 * API Route to fetch exchange rates from DolarAPI.com
 * Endpoints used:
 *   - https://dolarapi.com/v1/dolares/bolsa (MEP)
 *   - https://dolarapi.com/v1/dolares/contadoconliqui (CCL)
 *   - https://api.argentinadatos.com/v1/cotizaciones/dolares (historical)
 */
export async function GET(request) {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type'); // 'current' or 'historical'

    try {
        if (type === 'historical') {
            // Fetch all historical data from ArgentinaDatos
            const res = await fetch('https://api.argentinadatos.com/v1/cotizaciones/dolares', {
                next: { revalidate: 3600 }, // Cache for 1 hour
            });
            if (!res.ok) throw new Error(`ArgentinaDatos API error: ${res.status}`);
            const data = await res.json();

            // Filter only MEP (bolsa) and CCL (contadoconliqui), group by date
            const ratesByDate = {};
            for (const entry of data) {
                if (entry.casa !== 'bolsa' && entry.casa !== 'contadoconliqui') continue;
                const date = entry.fecha;
                if (!ratesByDate[date]) ratesByDate[date] = {};
                if (entry.casa === 'bolsa') {
                    ratesByDate[date].mep = {
                        compra: entry.compra,
                        venta: entry.venta,
                    };
                } else if (entry.casa === 'contadoconliqui') {
                    ratesByDate[date].ccl = {
                        compra: entry.compra,
                        venta: entry.venta,
                    };
                }
            }

            return NextResponse.json({ ratesByDate });
        }

        // Default: fetch current rates
        const [mepRes, cclRes] = await Promise.all([
            fetch('https://dolarapi.com/v1/dolares/bolsa'),
            fetch('https://dolarapi.com/v1/dolares/contadoconliqui'),
        ]);

        if (!mepRes.ok || !cclRes.ok) {
            throw new Error('DolarAPI request failed');
        }

        const mep = await mepRes.json();
        const ccl = await cclRes.json();

        return NextResponse.json({
            mep: {
                compra: mep.compra,
                venta: mep.venta,
                fecha: mep.fechaActualizacion,
            },
            ccl: {
                compra: ccl.compra,
                venta: ccl.venta,
                fecha: ccl.fechaActualizacion,
            },
            fetchedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Exchange rate fetch error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
