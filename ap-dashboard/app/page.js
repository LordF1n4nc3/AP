'use client';

import { useState, useCallback, useEffect } from 'react';
import { AppProvider, useApp } from './lib/store';
import {
  parseTenenciaPDF,
  parseMovimientosXLS,
  calculateTWR,
  calculatePerformance,
  getTotalDeposits,
  getTotalWithdrawals,
  formatCurrency,
  formatPercent,
} from './lib/parsers';
import { supabase } from './lib/supabase';

function AppContent() {
  const { state, dispatch } = useApp();
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientTab, setClientTab] = useState('overview');

  // Auth State
  const [session, setSession] = useState(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);

  // Subscribe to Auth status
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError('');
    if (isSignUp) {
      const { error } = await supabase.auth.signUp({ email: authEmail, password: authPassword });
      if (error) setAuthError(error.message);
      else setAuthError('¡Chequeá tu email para confirmar la cuenta!');
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
      if (error) setAuthError('Email o contraseña incorrectos');
    }
    setAuthLoading(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const isAdmin = session?.user?.email?.toLowerCase() === 'caneignacio@gmail.com';

  const clients = Object.values(state.clients);

  // Auto-fetch exchange rates on mount if not fetched today
  useEffect(() => {
    const today = new Date().toISOString().split('T')[0];
    const lastFetch = state.ratesLastFetch ? state.ratesLastFetch.split('T')[0] : null;

    async function fetchRates() {
      try {
        // Fetch current rates if not fetched today
        if (lastFetch !== today) {
          const res = await fetch('/api/rates?type=current');
          if (res.ok) {
            const data = await res.json();
            dispatch({
              type: 'SET_RATES',
              payload: { usd: data.mep.venta, ccl: data.ccl.venta },
            });
            dispatch({
              type: 'SET_RATES_HISTORY',
              payload: {
                ratesByDate: {
                  [today]: {
                    mep: { compra: data.mep.compra, venta: data.mep.venta },
                    ccl: { compra: data.ccl.compra, venta: data.ccl.venta },
                  },
                },
              },
            });
          }
        }

        // Fetch historical rates if we don't have data from mid-2025
        const historyKeys = Object.keys(state.ratesHistory || {});
        const hasOldData = historyKeys.some(d => d <= '2025-07-01');
        if (!hasOldData) {
          const hRes = await fetch('/api/rates?type=historical');
          if (hRes.ok) {
            const hData = await hRes.json();
            dispatch({
              type: 'SET_RATES_HISTORY',
              payload: { ratesByDate: hData.ratesByDate },
            });
          }
        }
      } catch (e) {
        console.error('Auto-fetch rates failed:', e);
      }
    }
    fetchRates();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Calculate aggregate stats
  const totalAUM = clients.reduce((sum, c) => {
    const latest = c.snapshots[c.snapshots.length - 1];
    if (!latest) return sum;
    const usdCashInArs = (latest.availableDolares || 0) * (state.usdRate || 1);
    return sum + (latest.totalValue || 0) + usdCashInArs;
  }, 0);

  const totalClients = clients.filter(c => c.snapshots.length > 0).length;

  const navigateToClient = (accountNumber) => {
    setSelectedClient(accountNumber);
    setCurrentPage('client-detail');
    setClientTab('overview');
  };

  if (!session) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--bg-color)' }}>
        <div style={{ padding: '40px', backgroundColor: 'var(--panel-bg)', borderRadius: '16px', border: '1px solid var(--border-color)', width: '360px', textAlign: 'center' }}>
          <div className="sidebar-logo" style={{ justifyContent: 'center', marginBottom: '32px' }}>
            <div className="sidebar-logo-icon">RC</div>
            <div className="sidebar-logo-text" style={{ textAlign: 'left' }}>
              <span className="sidebar-logo-title">RC Partners</span>
              <span className="sidebar-logo-subtitle">Portal de Inversores</span>
            </div>
          </div>

          <form onSubmit={handleAuth} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <input
              type="email"
              placeholder="Email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              required
              className="search-input"
              style={{ padding: '12px' }}
            />
            <input
              type="password"
              placeholder="Contraseña"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              required
              className="search-input"
              style={{ padding: '12px' }}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={authLoading}
              style={{ padding: '12px', justifyContent: 'center', marginTop: '8px' }}
            >
              {authLoading ? 'Cargando...' : isSignUp ? 'Crear Cuenta' : 'Ingresar'}
            </button>
          </form>

          {authError && <p style={{ color: 'var(--text-negative)', marginTop: '16px', fontSize: '14px' }}>{authError}</p>}

          <button
            type="button"
            onClick={() => { setIsSignUp(!isSignUp); setAuthError(''); }}
            style={{ marginTop: '24px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '13px' }}
          >
            {isSignUp ? '¿Ya tenés cuenta? Ingresá' : 'Crear una nueva cuenta'}
          </button>
        </div>
      </div>
    );
  }

  // If not admin, force them to client detail view for now
  // We will need to map their email to an account later.
  if (!isAdmin) {
    return (
      <div className="app-layout">
        <main className="main-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
            <h2>¡Hola, {session.user.email}!</h2>
            <p>Tu cuenta de inversión está siendo verificada y vinculada por RC Partners.</p>
            <button onClick={handleLogout} className="btn" style={{ marginTop: '24px' }}>Cerrar sesión</button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <div className="sidebar-logo-icon">RC</div>
            <div className="sidebar-logo-text">
              <span className="sidebar-logo-title">RC Partners</span>
              <span className="sidebar-logo-subtitle">Dashboard AP</span>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <span className="sidebar-section-title">Principal</span>
          <button
            className={`nav-item ${currentPage === 'dashboard' ? 'active' : ''}`}
            onClick={() => setCurrentPage('dashboard')}
          >
            <span className="nav-icon">📊</span>
            Dashboard
          </button>
          <button
            className={`nav-item ${currentPage === 'clients' ? 'active' : ''}`}
            onClick={() => setCurrentPage('clients')}
          >
            <span className="nav-icon">👥</span>
            Clientes
          </button>

          <span className="sidebar-section-title">Datos</span>
          <button
            className={`nav-item ${currentPage === 'upload' ? 'active' : ''}`}
            onClick={() => setCurrentPage('upload')}
          >
            <span className="nav-icon">📁</span>
            Cargar Archivos
          </button>

          <span className="sidebar-section-title">Configuración</span>
          <button
            className={`nav-item ${currentPage === 'settings' ? 'active' : ''}`}
            onClick={() => setCurrentPage('settings')}
          >
            <span className="nav-icon">⚙️</span>
            Cotizaciones
          </button>
        </nav>

        <div style={{ padding: '16px 12px', borderTop: '1px solid var(--border-color)' }}>
          <button
            onClick={handleLogout}
            className="nav-item"
            style={{ width: '100%', justifyContent: 'flex-start', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <span className="nav-icon">🚪</span>
            Cerrar Sesión
          </button>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '12px' }}>
            <div>v0.3.5 • Conectado a Vercel</div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {currentPage === 'dashboard' && (
          <DashboardPage clients={clients} totalAUM={totalAUM} totalClients={totalClients} onNavigate={navigateToClient} currency={state.selectedCurrency} dispatch={dispatch} usdRate={state.usdRate} cclRate={state.cclRate} />
        )}
        {currentPage === 'clients' && (
          <ClientsPage clients={clients} onNavigate={navigateToClient} currency={state.selectedCurrency} dispatch={dispatch} usdRate={state.usdRate} cclRate={state.cclRate} ratesHistory={state.ratesHistory} />
        )}
        {currentPage === 'client-detail' && selectedClient && (
          <ClientDetailPage
            client={state.clients[selectedClient]}
            tab={clientTab}
            setTab={setClientTab}
            onBack={() => setCurrentPage('clients')}
            currency={state.selectedCurrency}
            dispatch={dispatch}
            usdRate={state.usdRate}
            cclRate={state.cclRate}
            ratesHistory={state.ratesHistory}
          />
        )}
        {currentPage === 'upload' && <UploadPage dispatch={dispatch} clients={clients} />}
        {currentPage === 'settings' && <SettingsPage state={state} dispatch={dispatch} />}
      </main>

      {/* Toasts */}
      <div className="toast-container">
        {state.toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type || 'info'}`}>
            <span>{t.type === 'success' ? '✅' : t.type === 'error' ? '❌' : 'ℹ️'}</span>
            <span style={{ flex: 1, fontSize: '14px' }}>{t.message}</span>
            <button className="btn-ghost btn-sm" onClick={() => dispatch({ type: 'REMOVE_TOAST', payload: t.id })}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===================================================
// DASHBOARD PAGE
// ===================================================
function DashboardPage({ clients, totalAUM, totalClients, onNavigate, currency, dispatch, usdRate, cclRate }) {
  const convertValue = (val) => {
    if (currency === 'USD' && usdRate) return val / usdRate;
    if (currency === 'USD_CCL' && cclRate) return val / cclRate;
    return val;
  };
  const currLabel = currency === 'ARS' ? 'ARS' : currency === 'USD' ? 'USD' : 'USD CCL';
  const currPrefix = currency === 'ARS' ? 'ARS' : 'USD';

  // Top clients by portfolio value
  const topClients = [...clients]
    .filter(c => c.snapshots.length > 0)
    .map(c => ({
      ...c,
      latestValue: c.snapshots[c.snapshots.length - 1]?.totalValue || 0,
      twr: calculateTWR(c.snapshots, c.movements),
    }))
    .sort((a, b) => b.latestValue - a.latestValue);

  return (
    <>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1>Dashboard</h1>
            <p>Resumen general de tu cartera administrada</p>
          </div>
          <CurrencySelector currency={currency} dispatch={dispatch} />
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card accent-blue">
          <div className="stat-label">AUM Total</div>
          <div className="stat-value">{formatCurrency(convertValue(totalAUM), currPrefix)}</div>
          <div className="stat-change positive" style={{ fontSize: '12px', background: 'none', padding: 0, color: 'var(--text-muted)' }}>
            Activos bajo administración ({currLabel})
          </div>
        </div>
        <div className="stat-card accent-green">
          <div className="stat-label">Clientes Activos</div>
          <div className="stat-value">{totalClients}</div>
          <div className="stat-change positive" style={{ fontSize: '12px', background: 'none', padding: 0, color: 'var(--text-muted)' }}>
            Con posiciones abiertas
          </div>
        </div>
        <div className="stat-card accent-purple">
          <div className="stat-label">Posiciones Totales</div>
          <div className="stat-value">
            {clients.reduce((sum, c) => {
              const latest = c.snapshots[c.snapshots.length - 1];
              return sum + (latest?.holdings?.length || 0);
            }, 0)}
          </div>
          <div className="stat-change positive" style={{ fontSize: '12px', background: 'none', padding: 0, color: 'var(--text-muted)' }}>
            Títulos en cartera
          </div>
        </div>
        <div className="stat-card accent-amber">
          <div className="stat-label">Movimientos Registrados</div>
          <div className="stat-value">
            {clients.reduce((sum, c) => sum + c.movements.length, 0)}
          </div>
          <div className="stat-change positive" style={{ fontSize: '12px', background: 'none', padding: 0, color: 'var(--text-muted)' }}>
            Operaciones totales cargadas
          </div>
        </div>
      </div>

      {topClients.length > 0 ? (
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Clientes por Cartera</div>
              <div className="card-subtitle">Ordenados por valor de portafolio</div>
            </div>
          </div>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Cuenta</th>
                  <th className="text-right">Cartera ({currLabel})</th>
                  <th className="text-right">Rendimiento</th>
                  <th className="text-right">Posiciones</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {topClients.map(c => (
                  <tr key={c.accountNumber}>
                    <td className="text-bold">{c.name}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>{c.accountNumber}</td>
                    <td className="text-right text-bold">
                      {formatCurrency(convertValue(c.latestValue), currPrefix)}
                    </td>
                    <td className={`text-right ${c.twr !== null ? (c.twr >= 0 ? 'text-positive' : 'text-negative') : ''}`}>
                      {c.twr !== null ? formatPercent(c.twr) : (
                        <span className="badge badge-neutral">Sin datos</span>
                      )}
                    </td>
                    <td className="text-right">{c.snapshots[c.snapshots.length - 1]?.holdings?.length || 0}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => onNavigate(c.accountNumber)}>
                        Ver →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">📈</div>
            <div className="empty-state-title">Sin datos aún</div>
            <div className="empty-state-text">
              Cargá archivos de tenencia (resumen de cuenta) desde la sección "Cargar Archivos" para empezar a ver tu dashboard.
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ===================================================
// CLIENTS PAGE
// ===================================================
function ClientsPage({ clients, onNavigate, currency, dispatch, usdRate, cclRate, ratesHistory }) {
  const [search, setSearch] = useState('');

  const convertValue = (val) => {
    if (currency === 'USD' && usdRate) return val / usdRate;
    if (currency === 'USD_CCL' && cclRate) return val / cclRate;
    return val;
  };
  const currPrefix = currency === 'ARS' ? 'ARS' : 'USD';
  const currLabel = currency === 'ARS' ? 'ARS' : currency === 'USD' ? 'USD' : 'USD CCL';

  const filtered = clients
    .filter(c => c.snapshots.length > 0)
    .filter(c =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.accountNumber.includes(search)
    );

  return (
    <>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1>Clientes</h1>
            <p>{filtered.length} clientes con posiciones activas</p>
          </div>
          <CurrencySelector currency={currency} dispatch={dispatch} />
        </div>
      </div>

      <div style={{ marginBottom: '24px' }}>
        <div className="search-bar">
          <span className="search-icon">🔍</span>
          <input
            id="client-search"
            type="text"
            placeholder="Buscar por nombre o número de cuenta..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {filtered.length > 0 ? (
        <div className="clients-grid">
          {filtered.map(c => {
            const latest = c.snapshots[c.snapshots.length - 1];
            const perf = calculatePerformance(c.snapshots, c.movements, ratesHistory, currency === 'USD_CCL' ? 'USD' : currency);
            const deposits = getTotalDeposits(c.movements);
            const withdrawals = getTotalWithdrawals(c.movements);

            return (
              <div key={c.accountNumber} className="client-card" onClick={() => onNavigate(c.accountNumber)}>
                <div className="client-card-header">
                  <div className="client-avatar">
                    {c.name.split(' ').map(n => n[0]).join('').substring(0, 2)}
                  </div>
                  <div>
                    <div className="client-name">{c.name}</div>
                    <div className="client-account">CTA: {c.accountNumber}</div>
                  </div>
                </div>
                <div className="client-stats">
                  <div className="client-stat">
                    <div className="client-stat-label">Cartera ({currLabel})</div>
                    <div className="client-stat-value">
                      {formatCurrency(convertValue((latest?.totalValue || 0) + ((latest?.availableDolares || 0) * (usdRate || 1))), currPrefix)}
                    </div>
                  </div>
                  <div className="client-stat">
                    <div className="client-stat-label">Rend. Total</div>
                    <div className="client-stat-value" style={{ color: perf.totalReturn !== null ? (perf.totalReturn >= 0 ? 'var(--color-success)' : 'var(--color-danger)') : 'var(--text-muted)' }}>
                      {perf.totalReturn !== null ? formatPercent(perf.totalReturn) : 'N/A'}
                    </div>
                    {perf.startDate && (
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Desde {perf.startDate}</div>
                    )}
                  </div>
                  <div className="client-stat">
                    <div className="client-stat-label">TIR Anualizada</div>
                    <div className="client-stat-value" style={{ color: perf.annualizedTIR !== null ? (perf.annualizedTIR >= 0 ? 'var(--color-success)' : 'var(--color-danger)') : 'var(--text-muted)' }}>
                      {perf.annualizedTIR !== null ? formatPercent(perf.annualizedTIR) : 'N/A'}
                    </div>
                  </div>
                  <div className="client-stat">
                    <div className="client-stat-label">Rend. YTD</div>
                    <div className="client-stat-value" style={{ color: perf.ytdReturn !== null ? (perf.ytdReturn >= 0 ? 'var(--color-success)' : 'var(--color-danger)') : 'var(--text-muted)' }}>
                      {perf.ytdReturn !== null ? formatPercent(perf.ytdReturn) : 'N/A'}
                    </div>
                    {perf.endDate && (
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Al {perf.endDate}</div>
                    )}
                  </div>
                  <div className="client-stat">
                    <div className="client-stat-label">Ingresos</div>
                    <div className="client-stat-value" style={{ fontSize: '13px', color: 'var(--color-success)' }}>
                      <FlowDisplay flow={deposits} convertValue={convertValue} currPrefix={currPrefix} usdRate={usdRate} />
                    </div>
                  </div>
                  <div className="client-stat">
                    <div className="client-stat-label">Egresos</div>
                    <div className="client-stat-value" style={{ fontSize: '13px', color: 'var(--color-danger)' }}>
                      <FlowDisplay flow={withdrawals} convertValue={convertValue} currPrefix={currPrefix} usdRate={usdRate} />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">👥</div>
            <div className="empty-state-title">{search ? 'Sin resultados' : 'Sin clientes'}</div>
            <div className="empty-state-text">
              {search
                ? `No se encontraron clientes para "${search}"`
                : 'Cargá archivos de tenencia para ver tus clientes acá.'
              }
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ===================================================
// CLIENT DETAIL PAGE
// ===================================================
function ClientDetailPage({ client, tab, setTab, onBack, currency, dispatch, usdRate, cclRate, ratesHistory }) {
  if (!client) return null;

  const convertValue = (val) => {
    if (currency === 'USD' && usdRate) return val / usdRate;
    if (currency === 'USD_CCL' && cclRate) return val / cclRate;
    return val;
  };
  const currPrefix = currency === 'ARS' ? 'ARS' : 'USD';
  const currLabel = currency === 'ARS' ? 'ARS' : currency === 'USD' ? 'USD' : 'USD CCL';

  const latest = client.snapshots[client.snapshots.length - 1];
  const perf = calculatePerformance(client.snapshots, client.movements, ratesHistory, currency === 'USD_CCL' ? 'USD' : currency);
  const totalDeposits = getTotalDeposits(client.movements);
  const totalWithdrawals = getTotalWithdrawals(client.movements);

  // Color palette for holdings
  const holdingColors = ['#6366f1', '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];

  return (
    <>
      <div className="page-header">
        <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: '12px' }}>
          ← Volver a Clientes
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div className="client-avatar" style={{ width: '56px', height: '56px', fontSize: '22px' }}>
              {client.name.split(' ').map(n => n[0]).join('').substring(0, 2)}
            </div>
            <div>
              <h1 style={{ marginBottom: '2px' }}>{client.name}</h1>
              <p style={{ fontFamily: 'monospace' }}>Cuenta: {client.accountNumber} · Ref: {client.refNumber}</p>
            </div>
          </div>
          <CurrencySelector currency={currency} dispatch={dispatch} />
        </div>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="stat-card accent-blue">
          <div className="stat-label">Cartera ({currLabel})</div>
          <div className="stat-value" style={{ fontSize: '20px' }}>
            {formatCurrency(convertValue((latest?.totalValue || 0) + ((latest?.availableDolares || 0) * (usdRate || 1))), currPrefix)}
          </div>
        </div>
        <div className="stat-card accent-green">
          <div className="stat-label">Rend. Total</div>
          <div className="stat-value" style={{ fontSize: '20px', color: perf.totalReturn !== null ? (perf.totalReturn >= 0 ? 'var(--color-success)' : 'var(--color-danger)') : 'inherit' }}>
            {perf.totalReturn !== null ? formatPercent(perf.totalReturn) : 'N/A'}
          </div>
          {perf.startDate && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>Desde {perf.startDate} al {perf.endDate}</div>
          )}
        </div>
        <div className="stat-card accent-green">
          <div className="stat-label">TIR Anualizada</div>
          <div className="stat-value" style={{ fontSize: '20px', color: perf.annualizedTIR !== null ? (perf.annualizedTIR >= 0 ? 'var(--color-success)' : 'var(--color-danger)') : 'inherit' }}>
            {perf.annualizedTIR !== null ? formatPercent(perf.annualizedTIR) : 'N/A'}
          </div>
        </div>
        <div className="stat-card accent-purple">
          <div className="stat-label">Rendimiento YTD</div>
          <div className="stat-value" style={{ fontSize: '20px', color: perf.ytdReturn !== null ? (perf.ytdReturn >= 0 ? 'var(--color-success)' : 'var(--color-danger)') : 'inherit' }}>
            {perf.ytdReturn !== null ? formatPercent(perf.ytdReturn) : 'N/A'}
          </div>
          {perf.endDate && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>Al {perf.endDate}</div>
          )}
        </div>
        <div className="stat-card accent-amber">
          <div className="stat-label">Total Ingresos</div>
          <div className="stat-value" style={{ fontSize: '18px', color: 'var(--color-success)' }}>
            <FlowDisplay flow={totalDeposits} convertValue={convertValue} currPrefix={currPrefix} usdRate={usdRate} />
          </div>
        </div>
        <div className="stat-card" style={{ borderLeft: '3px solid var(--color-danger)' }}>
          <div className="stat-label">Total Egresos</div>
          <div className="stat-value" style={{ fontSize: '18px', color: 'var(--color-danger)' }}>
            <FlowDisplay flow={totalWithdrawals} convertValue={convertValue} currPrefix={currPrefix} usdRate={usdRate} />
          </div>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>
          Posiciones
        </button>
        <button className={`tab ${tab === 'movements' ? 'active' : ''}`} onClick={() => setTab('movements')}>
          Movimientos ({client.movements.length})
        </button>
        <button className={`tab ${tab === 'snapshots' ? 'active' : ''}`} onClick={() => setTab('snapshots')}>
          Historial ({client.snapshots.length})
        </button>
      </div>

      {tab === 'overview' && latest && (
        <div className="details-grid">
          <div className="card">
            <div className="card-header">
              <div className="card-title">Composición de Cartera</div>
            </div>
            {latest.holdings && latest.holdings.length > 0 && (
              <>
                <div className="holdings-bar">
                  {latest.holdings.map((h, i) => (
                    <div
                      key={h.ticker}
                      className="holdings-bar-segment"
                      style={{
                        width: `${(h.valuation / latest.totalValue) * 100}%`,
                        background: holdingColors[i % holdingColors.length],
                      }}
                    />
                  ))}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {latest.holdings.map((h, i) => (
                    <div key={h.ticker} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                      <div style={{ width: '10px', height: '10px', borderRadius: '3px', background: holdingColors[i % holdingColors.length] }} />
                      <span className="text-bold">{h.ticker}</span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {((h.valuation / latest.totalValue) * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title">Detalle de Títulos</div>
            </div>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th className="text-right">Cant.</th>
                    <th className="text-right">Precio</th>
                    <th className="text-right">Valuación</th>
                    <th className="text-right">% Cartera</th>
                  </tr>
                </thead>
                <tbody>
                  {(latest.holdings || []).map(h => (
                    <tr key={h.ticker}>
                      <td>
                        <span className="ticker-tag">{h.ticker}</span>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>{h.description}</div>
                      </td>
                      <td className="text-right text-bold">{h.quantity}</td>
                      <td className="text-right">{formatCurrency(convertValue(h.price), currPrefix)}</td>
                      <td className="text-right text-bold">{formatCurrency(convertValue(h.valuation), currPrefix)}</td>
                      <td className="text-right">
                        <span className="badge badge-info">
                          {((h.valuation / latest.totalValue) * 100).toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'overview' && (!latest || !latest.holdings || latest.holdings.length === 0) && (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <div className="empty-state-title">Sin posiciones</div>
            <div className="empty-state-text">Este cliente no tiene títulos en cartera en el último reporte.</div>
          </div>
        </div>
      )}

      {tab === 'movements' && (
        <div className="card">
          {client.movements.length > 0 ? (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Tipo</th>
                    <th>Ticker</th>
                    <th className="text-right">Cantidad</th>
                    <th className="text-right">Monto</th>
                    <th>Moneda</th>
                    <th>Clasificación</th>
                  </tr>
                </thead>
                <tbody>
                  {[...client.movements].reverse().map((m, i) => (
                    <tr key={`${m.movNumber}-${i}`}>
                      <td style={{ whiteSpace: 'nowrap' }}>{m.concertDate}</td>
                      <td style={{ maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {m.tipoMov}
                      </td>
                      <td>{m.ticker ? <span className="ticker-tag">{m.ticker}</span> : '-'}</td>
                      <td className="text-right">{m.cantidad || '-'}</td>
                      <td className={`text-right ${m.monto >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {formatCurrency(m.monto, m.moneda === 'USD' ? 'USD' : 'ARS')}
                      </td>
                      <td><span className="badge badge-neutral">{m.moneda}</span></td>
                      <td>
                        <span className={`badge ${m.classification === 'DEPOSIT' ? 'badge-success' :
                          m.classification === 'WITHDRAWAL' ? 'badge-danger' :
                            m.classification === 'BUY' ? 'badge-info' :
                              m.classification === 'SELL' ? 'badge-warning' :
                                m.classification === 'DIVIDEND' || m.classification === 'COUPON' ? 'badge-success' :
                                  'badge-neutral'
                          }`}>
                          {m.classification === 'DEPOSIT' ? '💰 Depósito' :
                            m.classification === 'WITHDRAWAL' ? '📤 Extracción' :
                              m.classification === 'BUY' ? '🟢 Compra' :
                                m.classification === 'SELL' ? '🔴 Venta' :
                                  m.classification === 'DIVIDEND' ? '💵 Dividendo' :
                                    m.classification === 'COUPON' ? '💵 Renta' :
                                      m.classification === 'CREDIT' ? '✨ Crédito' :
                                        m.classification}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">📄</div>
              <div className="empty-state-title">Sin movimientos</div>
              <div className="empty-state-text">Cargá un archivo de movimientos históricos y asignalo a este cliente.</div>
            </div>
          )}
        </div>
      )}

      {tab === 'snapshots' && (
        <div className="card">
          {client.snapshots.length > 0 ? (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th className="text-right">Cartera ({currLabel})</th>
                    <th className="text-right">Posiciones</th>
                    <th className="text-right">Disp. Pesos</th>
                    <th className="text-right">Disp. Dólares</th>
                  </tr>
                </thead>
                <tbody>
                  {[...client.snapshots].reverse().map((s, i) => (
                    <tr key={`${s.date}-${i}`}>
                      <td className="text-bold">{s.date}</td>
                      <td className="text-right text-bold">{formatCurrency(convertValue(s.totalValue), currPrefix)}</td>
                      <td className="text-right">{s.holdings?.length || 0}</td>
                      <td className="text-right">{formatCurrency(s.availablePesos, 'ARS')}</td>
                      <td className="text-right">{formatCurrency(s.availableDolares, 'USD')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">📸</div>
              <div className="empty-state-title">Sin historial</div>
              <div className="empty-state-text">Cargá más archivos de tenencia de distintas fechas para ver el historial.</div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ===================================================
// UPLOAD PAGE
// ===================================================
function UploadPage({ dispatch, clients }) {
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [unassignedMovements, setUnassignedMovements] = useState([]);

  const handleTenenciaUpload = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setProcessing(true);

    for (const file of files) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', 'tenencia');

        const res = await fetch('/api/parse', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        const parsed = parseTenenciaPDF(data.text);
        if (parsed.accountNumber) {
          dispatch({
            type: 'ADD_SNAPSHOT',
            payload: { accountNumber: parsed.accountNumber, data: parsed },
          });
          setUploadedFiles(prev => [...prev, {
            name: file.name,
            status: 'success',
            message: `${parsed.name} - CTA: ${parsed.accountNumber}`,
          }]);
          dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `Tenencia cargada: ${parsed.name}` } });
          setTimeout(() => dispatch({ type: 'REMOVE_TOAST', payload: Date.now() }), 4000);
        } else {
          throw new Error('No se pudo extraer el número de cuenta');
        }
      } catch (err) {
        setUploadedFiles(prev => [...prev, {
          name: file.name,
          status: 'error',
          message: err.message,
        }]);
        dispatch({ type: 'ADD_TOAST', payload: { type: 'error', message: `Error: ${err.message}` } });
        setTimeout(() => dispatch({ type: 'REMOVE_TOAST', payload: Date.now() }), 4000);
      }
    }
    setProcessing(false);
    e.target.value = '';
  }, [dispatch]);

  const handleMovimientosUpload = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setProcessing(true);

    for (const file of files) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', 'movimientos');

        const res = await fetch('/api/parse', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        const parsed = parseMovimientosXLS(data.html);

        if (parsed.movements.length === 0) throw new Error('No se encontraron movimientos');

        // Try to auto-assign to a client
        // If there's only one client, assign automatically
        const clientList = Object.values(clients).filter(c => c.snapshots.length > 0);
        if (clientList.length === 1) {
          dispatch({
            type: 'ASSIGN_MOVEMENTS',
            payload: { accountNumber: clientList[0].accountNumber, movements: parsed.movements },
          });
          setUploadedFiles(prev => [...prev, {
            name: file.name,
            status: 'success',
            message: `${parsed.movements.length} movimientos → ${clientList[0].name}`,
          }]);
          dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `${parsed.movements.length} movimientos cargados para ${clientList[0].name}` } });
        } else {
          // Store for manual assignment
          setUnassignedMovements(prev => [...prev, {
            fileName: file.name,
            movements: parsed.movements,
            period: `${parsed.periodStart} - ${parsed.periodEnd}`,
          }]);
          setUploadedFiles(prev => [...prev, {
            name: file.name,
            status: 'success',
            message: `${parsed.movements.length} movimientos - Asignar a cliente`,
          }]);
        }
      } catch (err) {
        setUploadedFiles(prev => [...prev, {
          name: file.name,
          status: 'error',
          message: err.message,
        }]);
      }
    }
    setProcessing(false);
    e.target.value = '';
  }, [dispatch, clients]);

  const assignMovements = (index, accountNumber) => {
    const batch = unassignedMovements[index];
    dispatch({
      type: 'ASSIGN_MOVEMENTS',
      payload: { accountNumber, movements: batch.movements },
    });
    setUnassignedMovements(prev => prev.filter((_, i) => i !== index));
    dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `Movimientos asignados exitosamente` } });
  };

  return (
    <>
      <div className="page-header">
        <h1>Cargar Archivos</h1>
        <p>Subi los archivos que descargás de IOL para procesar automáticamente</p>
      </div>

      <div className="upload-grid">
        {/* Tenencias Upload */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">📋 Tenencias (Resumen de Cuenta)</div>
              <div className="card-subtitle">Archivos PDF descargados de IOL</div>
            </div>
          </div>
          <div className={`upload-zone ${processing ? 'processing' : ''}`}>
            <input
              id="tenencia-upload"
              type="file"
              accept=".pdf"
              multiple
              onChange={handleTenenciaUpload}
              disabled={processing}
            />
            <div className="upload-zone-icon">📄</div>
            <div className="upload-zone-title">
              {processing ? 'Procesando...' : 'Arrastrá o hacé click'}
            </div>
            <div className="upload-zone-subtitle">
              Archivos PDF de resumen de cuenta (resumen_cuenta_*.pdf)
            </div>
          </div>
        </div>

        {/* Movimientos Upload */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">📊 Movimientos Históricos</div>
              <div className="card-subtitle">Archivos XLS descargados de IOL</div>
            </div>
          </div>
          <div className={`upload-zone ${processing ? 'processing' : ''}`}>
            <input
              id="movimientos-upload"
              type="file"
              accept=".xls,.xlsx,.html"
              multiple
              onChange={handleMovimientosUpload}
              disabled={processing}
            />
            <div className="upload-zone-icon">📈</div>
            <div className="upload-zone-title">
              {processing ? 'Procesando...' : 'Arrastrá o hacé click'}
            </div>
            <div className="upload-zone-subtitle">
              Archivos XLS de movimientos históricos (MovimientosHistoricos*.xls)
            </div>
          </div>
        </div>
      </div>

      {/* Unassigned movements */}
      {unassignedMovements.length > 0 && (
        <div className="card" style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <div className="card-title">⚠️ Movimientos sin asignar</div>
          </div>
          {unassignedMovements.map((batch, idx) => (
            <div key={idx} className="file-item" style={{ marginBottom: '8px' }}>
              <div className="file-item-info">
                <span className="file-icon">📊</span>
                <div>
                  <div className="file-name">{batch.fileName}</div>
                  <div className="file-meta">{batch.movements.length} movimientos · {batch.period}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <select
                  id={`assign-select-${idx}`}
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-primary)',
                    padding: '6px 12px',
                    fontSize: '13px',
                    fontFamily: 'Inter, sans-serif',
                  }}
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) assignMovements(idx, e.target.value);
                  }}
                >
                  <option value="">Seleccionar cliente...</option>
                  {Object.values(clients).filter(c => c.snapshots.length > 0).map(c => (
                    <option key={c.accountNumber} value={c.accountNumber}>
                      {c.name} ({c.accountNumber})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Uploaded files list */}
      {uploadedFiles.length > 0 && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Archivos Procesados</div>
          </div>
          <div className="file-list">
            {uploadedFiles.map((f, i) => (
              <div key={i} className="file-item">
                <div className="file-item-info">
                  <span className="file-icon">{f.status === 'success' ? '✅' : '❌'}</span>
                  <div>
                    <div className="file-name">{f.name}</div>
                    <div className="file-meta">{f.message}</div>
                  </div>
                </div>
                <div className={`file-status ${f.status}`}>
                  {f.status === 'success' ? 'Procesado' : 'Error'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ===================================================
// SETTINGS PAGE
// ===================================================
function SettingsPage({ state, dispatch }) {
  const [fetching, setFetching] = useState(false);
  const [fetchingHistory, setFetchingHistory] = useState(false);

  const inputStyle = {
    width: '100%',
    padding: '10px 16px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: '16px',
    fontFamily: 'Inter, sans-serif',
    outline: 'none',
  };

  const fetchCurrentRates = async () => {
    setFetching(true);
    try {
      const res = await fetch('/api/rates?type=current');
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const today = new Date().toISOString().split('T')[0];
      dispatch({
        type: 'SET_RATES',
        payload: { usd: data.mep.venta, ccl: data.ccl.venta },
      });
      dispatch({
        type: 'SET_RATES_HISTORY',
        payload: {
          ratesByDate: {
            [today]: {
              mep: { compra: data.mep.compra, venta: data.mep.venta },
              ccl: { compra: data.ccl.compra, venta: data.ccl.venta },
            },
          },
        },
      });
      dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `Cotización actualizada: MEP $${data.mep.venta} · CCL $${data.ccl.venta}` } });
    } catch (e) {
      dispatch({ type: 'ADD_TOAST', payload: { type: 'error', message: `Error: ${e.message}` } });
    }
    setFetching(false);
  };

  const fetchHistoricalRates = async () => {
    setFetchingHistory(true);
    try {
      const res = await fetch('/api/rates?type=historical');
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      dispatch({
        type: 'SET_RATES_HISTORY',
        payload: { ratesByDate: data.ratesByDate },
      });
      const count = Object.keys(data.ratesByDate).length;
      dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `${count} días de cotizaciones históricas cargadas` } });
    } catch (e) {
      dispatch({ type: 'ADD_TOAST', payload: { type: 'error', message: `Error: ${e.message}` } });
    }
    setFetchingHistory(false);
  };

  // Get last 30 days of history for the table
  const historyDates = Object.keys(state.ratesHistory || {})
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 30);

  const lastFetchFormatted = state.ratesLastFetch
    ? new Date(state.ratesLastFetch).toLocaleString('es-AR')
    : 'Nunca';

  return (
    <>
      <div className="page-header">
        <h1>Cotizaciones</h1>
        <p>Tipos de cambio USD MEP y USD CCL — Fuente: DolarAPI.com (gratis, sin límite)</p>
      </div>

      <div className="details-grid">
        {/* Current rates card */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">💱 Cotización Actual</div>
              <div className="card-subtitle">Última actualización: {lastFetchFormatted}</div>
            </div>
          </div>

          <div className="stats-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: '20px' }}>
            <div className="stat-card accent-blue" style={{ padding: '16px' }}>
              <div className="stat-label">USD MEP (Bolsa)</div>
              <div className="stat-value" style={{ fontSize: '24px' }}>
                {state.usdRate ? `$ ${state.usdRate.toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '-'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>Precio venta</div>
            </div>
            <div className="stat-card accent-purple" style={{ padding: '16px' }}>
              <div className="stat-label">USD CCL</div>
              <div className="stat-value" style={{ fontSize: '24px' }}>
                {state.cclRate ? `$ ${state.cclRate.toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : '-'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>Precio venta</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              className="btn btn-primary"
              onClick={fetchCurrentRates}
              disabled={fetching}
              style={{ flex: 1 }}
            >
              {fetching ? <><span className="spinner" style={{ width: '16px', height: '16px' }} /> Consultando...</> : '🔄 Actualizar Cotización'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={fetchHistoricalRates}
              disabled={fetchingHistory}
              style={{ flex: 1 }}
            >
              {fetchingHistory ? <><span className="spinner" style={{ width: '16px', height: '16px' }} /> Descargando...</> : '📥 Descargar Historial'}
            </button>
          </div>

          <div style={{ marginTop: '16px', padding: '12px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', fontSize: '12px', color: 'var(--text-muted)' }}>
            <strong style={{ color: 'var(--text-secondary)' }}>ℹ️ Fuente:</strong> DolarAPI.com + ArgentinaDatos.com — APIs públicas y gratuitas.
            La cotización se actualiza automáticamente al abrir la app cada día.
          </div>
        </div>

        {/* History table */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">📅 Historial de Cierres</div>
              <div className="card-subtitle">{Object.keys(state.ratesHistory || {}).length} días guardados</div>
            </div>
          </div>

          {historyDates.length > 0 ? (
            <div className="table-container" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th className="text-right">MEP Compra</th>
                    <th className="text-right">MEP Venta</th>
                    <th className="text-right">CCL Compra</th>
                    <th className="text-right">CCL Venta</th>
                  </tr>
                </thead>
                <tbody>
                  {historyDates.map(date => {
                    const r = state.ratesHistory[date];
                    return (
                      <tr key={date}>
                        <td className="text-bold" style={{ whiteSpace: 'nowrap' }}>{date}</td>
                        <td className="text-right">{r.mep ? `$ ${r.mep.compra?.toLocaleString('es-AR', { minimumFractionDigits: 1 })}` : '-'}</td>
                        <td className="text-right text-bold">{r.mep ? `$ ${r.mep.venta?.toLocaleString('es-AR', { minimumFractionDigits: 1 })}` : '-'}</td>
                        <td className="text-right">{r.ccl ? `$ ${r.ccl.compra?.toLocaleString('es-AR', { minimumFractionDigits: 1 })}` : '-'}</td>
                        <td className="text-right text-bold">{r.ccl ? `$ ${r.ccl.venta?.toLocaleString('es-AR', { minimumFractionDigits: 1 })}` : '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state" style={{ padding: '32px' }}>
              <div className="empty-state-icon" style={{ fontSize: '36px' }}>📊</div>
              <div className="empty-state-title" style={{ fontSize: '15px' }}>Sin historial</div>
              <div className="empty-state-text" style={{ fontSize: '13px' }}>
                Hacé click en "Descargar Historial" para cargar todos los cierres diarios disponibles.
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ===================================================
// FLOW DISPLAY COMPONENT (shows ARS + USD deposits/withdrawals)
// ===================================================
function FlowDisplay({ flow, convertValue, currPrefix, usdRate }) {
  if (!flow || (flow.ars === 0 && flow.usd === 0)) return '-';

  if (currPrefix === 'USD') {
    // Convert ARS to USD and add USD flows
    const arsInUsd = usdRate && usdRate > 0 ? (flow.ars || 0) / usdRate : 0;
    const total = arsInUsd + (flow.usd || 0);
    return formatCurrency(total, 'USD');
  } else {
    // ARS mode: convert USD to ARS and add ARS flows
    const usdInArs = (flow.usd || 0) * (usdRate || 1);
    const total = (flow.ars || 0) + usdInArs;
    return formatCurrency(total, 'ARS');
  }
}

// ===================================================
// CURRENCY SELECTOR COMPONENT
// ===================================================
function CurrencySelector({ currency, dispatch }) {
  return (
    <div className="currency-selector">
      <button
        className={`currency-btn ${currency === 'ARS' ? 'active' : ''}`}
        onClick={() => dispatch({ type: 'SET_CURRENCY', payload: 'ARS' })}
      >
        ARS
      </button>
      <button
        className={`currency-btn ${currency === 'USD' ? 'active' : ''}`}
        onClick={() => dispatch({ type: 'SET_CURRENCY', payload: 'USD' })}
      >
        USD
      </button>
      <button
        className={`currency-btn ${currency === 'USD_CCL' ? 'active' : ''}`}
        onClick={() => dispatch({ type: 'SET_CURRENCY', payload: 'USD_CCL' })}
      >
        CCL
      </button>
    </div>
  );
}

// ===================================================
// MAIN EXPORT
// ===================================================
export default function Home() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
