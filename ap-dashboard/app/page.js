'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
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
  getRateForDate,
  getMepRate,
} from './lib/parsers';
import { supabase } from './lib/supabase';

async function syncHistoricalMepForDates(dates, ratesHistory, dispatch) {
  const normalizedDates = [...new Set((dates || []).filter(Boolean))].sort();
  const missingDates = normalizedDates.filter(date => !getMepRate(getRateForDate(ratesHistory, date)));

  if (missingDates.length === 0) {
    return { syncedDates: [], skipped: true };
  }

  const desde = missingDates[0];
  const hasta = missingDates[missingDates.length - 1];

  const res = await fetch('/api/iol', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'historical_mep',
      params: { desde, hasta },
    }),
  });

  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(json.error || 'No se pudo sincronizar el MEP histórico');
  }

  const ratesByDate = json.data?.ratesByDate || {};
  if (Object.keys(ratesByDate).length > 0) {
    dispatch({
      type: 'SET_RATES_HISTORY',
      payload: { ratesByDate },
    });
  }

  return { syncedDates: Object.keys(ratesByDate), skipped: false };
}

async function loadCloudStateForSession(session, isAdmin) {
  if (!session?.user?.email) {
    return { clients: {} };
  }

  if (isAdmin) {
    const [{ data: clientRows, error: clientsError }, { data: financialRows, error: financialError }] = await Promise.all([
      supabase.from('clientes').select('cuenta, nombre, email_asignado'),
      supabase.from('datos_financieros').select('cuenta, datos_json'),
    ]);

    if (clientsError) throw clientsError;
    if (financialError) throw financialError;

    const clientMetaByAccount = Object.fromEntries((clientRows || []).map(row => [row.cuenta, row]));
    const clients = {};

    for (const row of financialRows || []) {
      const accountNumber = row.cuenta;
      const meta = clientMetaByAccount[accountNumber] || {};
      const clientData = row.datos_json || {};
      clients[accountNumber] = {
        snapshots: [],
        movements: [],
        ...clientData,
        accountNumber,
        name: clientData.name || meta.nombre || accountNumber,
        assignedEmail: clientData.assignedEmail || meta.email_asignado || null,
      };
    }

    return { clients };
  }

  const { data: clientRows, error: clientsError } = await supabase
    .from('clientes')
    .select('cuenta, nombre, email_asignado')
    .eq('email_asignado', session.user.email.toLowerCase());

  if (clientsError) throw clientsError;

  const accounts = (clientRows || []).map(row => row.cuenta).filter(Boolean);
  if (accounts.length === 0) {
    return { clients: {} };
  }

  const { data: financialRows, error: financialError } = await supabase
    .from('datos_financieros')
    .select('cuenta, datos_json')
    .in('cuenta', accounts);

  if (financialError) throw financialError;

  const metaByAccount = Object.fromEntries((clientRows || []).map(row => [row.cuenta, row]));
  const clients = {};

  for (const row of financialRows || []) {
    const accountNumber = row.cuenta;
    const meta = metaByAccount[accountNumber] || {};
    const clientData = row.datos_json || {};
    clients[accountNumber] = {
      snapshots: [],
      movements: [],
      ...clientData,
      accountNumber,
      name: clientData.name || meta.nombre || accountNumber,
      assignedEmail: clientData.assignedEmail || meta.email_asignado || session.user.email.toLowerCase(),
    };
  }

  return { clients };
}

function mergeClientRecords(localClient = {}, cloudClient = {}) {
  const mergedSnapshotsMap = new Map();
  [...(cloudClient.snapshots || []), ...(localClient.snapshots || [])].forEach(snapshot => {
    if (snapshot?.date) {
      mergedSnapshotsMap.set(snapshot.date, snapshot);
    }
  });

  const mergedMovementsMap = new Map();
  [...(cloudClient.movements || []), ...(localClient.movements || [])].forEach((movement, index) => {
    const key = movement?.movNumber ? `mov-${movement.movNumber}` : `idx-${index}-${movement?.concertDate || ''}-${movement?.monto || ''}`;
    mergedMovementsMap.set(key, movement);
  });

  const mergedManualFlowsMap = new Map();
  [...(cloudClient.manualFlows || []), ...(localClient.manualFlows || [])].forEach((flow, index) => {
    const key = flow?.id ? `flow-${flow.id}` : `idx-${index}-${flow?.date || ''}-${flow?.amount || ''}`;
    mergedManualFlowsMap.set(key, flow);
  });

  const mergedRatesHistory = { ...(cloudClient.ratesHistory || {}), ...(localClient.ratesHistory || {}) };

  return {
    ...cloudClient,
    ...localClient,
    snapshots: [...mergedSnapshotsMap.values()].sort((a, b) => (a.date || '').localeCompare(b.date || '')),
    movements: [...mergedMovementsMap.values()].sort((a, b) => (a.concertDate || '').localeCompare(b.concertDate || '')),
    manualFlows: [...mergedManualFlowsMap.values()].sort((a, b) => (a.date || '').localeCompare(b.date || '')),
    tirFlowKeys: [...new Set([...(cloudClient.tirFlowKeys || []), ...(localClient.tirFlowKeys || [])])],
    ratesHistory: mergedRatesHistory,
  };
}

function mergeClientsByAccount(localClients = {}, cloudClients = {}) {
  const allAccounts = new Set([...Object.keys(cloudClients || {}), ...Object.keys(localClients || {})]);
  const merged = {};

  for (const accountNumber of allAccounts) {
    merged[accountNumber] = mergeClientRecords(localClients[accountNumber], cloudClients[accountNumber]);
  }

  return merged;
}

async function upsertClientToCloud(client, assignedEmailOverride) {
  const rawAssignedEmail = assignedEmailOverride ?? client.assignedEmail ?? '';
  const assignedEmail = rawAssignedEmail.trim().toLowerCase() || null;

  const { error: clientError } = await supabase
    .from('clientes')
    .upsert({
      cuenta: client.accountNumber,
      nombre: client.name,
      email_asignado: assignedEmail,
    }, { onConflict: 'cuenta' });

  if (clientError) throw clientError;

  const { error: dataError } = await supabase
    .from('datos_financieros')
    .upsert({
      cuenta: client.accountNumber,
      datos_json: {
        ...client,
        assignedEmail,
      },
    }, { onConflict: 'cuenta' });

  if (dataError) throw dataError;
}

function getFlowTotalInCurrency(flow, currency, usdRate) {
  if (!flow) return 0;

  if (currency === 'USD' || currency === 'USD_CCL') {
    const arsInUsd = usdRate > 0 ? (flow.ars || 0) / usdRate : 0;
    return arsInUsd + (flow.usd || 0);
  }

  const usdInArs = (flow.usd || 0) * (usdRate || 1);
  return (flow.ars || 0) + usdInArs;
}

function getNominalGainValue(portfolioValue, deposits, withdrawals, currency, usdRate) {
  const depositsInCurrency = getFlowTotalInCurrency(deposits, currency, usdRate);
  const withdrawalsInCurrency = getFlowTotalInCurrency(withdrawals, currency, usdRate);
  const netContributions = depositsInCurrency - withdrawalsInCurrency;
  return portfolioValue - netContributions;
}

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
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudStatus, setCloudStatus] = useState('');
  const [bulkCloudSaving, setBulkCloudSaving] = useState(false);
  const previousSessionEmailRef = useRef(null);
  const currentClientsRef = useRef(state.clients);

  useEffect(() => {
    currentClientsRef.current = state.clients;
  }, [state.clients]);

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

  useEffect(() => {
    const currentEmail = session?.user?.email?.toLowerCase() || null;
    if (previousSessionEmailRef.current !== currentEmail) {
      previousSessionEmailRef.current = currentEmail;
      setCloudStatus('');
      dispatch({ type: 'RESET_DB_LOADED' });
    }
  }, [session?.user?.email, dispatch]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateFromCloud() {
      if (!session || state.dbLoaded) return;

      setCloudLoading(true);
      setCloudStatus('');
      try {
        const { clients: cloudClients } = await loadCloudStateForSession(session, isAdmin);
        if (cancelled) return;

        const hasCloudClients = Object.keys(cloudClients || {}).length > 0;

        if (hasCloudClients) {
          dispatch({ type: 'LOAD_STATE', payload: { clients: mergeClientsByAccount(currentClientsRef.current, cloudClients) } });
          setCloudStatus('Datos cargados desde Supabase.');
        } else {
          setCloudStatus('No hay clientes guardados en Supabase.');
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Cloud load failed:', err);
          const message = `No se pudo cargar la nube${err?.message ? `: ${err.message}` : ''}. Se usan los datos locales.`;
          setCloudStatus(message);
          dispatch({ type: 'ADD_TOAST', payload: { type: 'error', message } });
        }
      } finally {
        if (!cancelled) {
          dispatch({ type: 'MARK_DB_LOADED' });
          setCloudLoading(false);
        }
      }
    }

    hydrateFromCloud();
    return () => {
      cancelled = true;
    };
  }, [session, isAdmin, state.dbLoaded, dispatch]);

  const totalAUM = clients.reduce((sum, c) => {
    const latest = c.snapshots[c.snapshots.length - 1];
    if (!latest) return sum;
    const currentMepRate = getMepRate(getRateForDate(state.ratesHistory, latest.date)) || 1;
    const usdCashInArs = (latest.availableDolares || 0) * currentMepRate;
    return sum + (latest.totalValue || 0) + usdCashInArs;
  }, 0);

  const totalClients = clients.filter(c => c.snapshots.length > 0).length;

  const navigateToClient = (accountNumber) => {
    setSelectedClient(accountNumber);
    setCurrentPage('client-detail');
    setClientTab('overview');
  };

  const handleBulkCloudSync = async () => {
    const clientsToSync = Object.values(state.clients).filter(client => client?.accountNumber);
    if (clientsToSync.length === 0) {
      dispatch({ type: 'ADD_TOAST', payload: { type: 'info', message: 'No hay clientes locales para sincronizar.' } });
      return;
    }

    setBulkCloudSaving(true);
    try {
      for (const client of clientsToSync) {
        await upsertClientToCloud(client);
      }
      const message = `Se sincronizaron ${clientsToSync.length} clientes a Supabase.`;
      setCloudStatus(message);
      dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message } });
    } catch (err) {
      console.error('Bulk cloud sync failed:', err);
      const message = `No se pudo sincronizar a Supabase${err?.message ? `: ${err.message}` : '.'}`;
      setCloudStatus(message);
      dispatch({ type: 'ADD_TOAST', payload: { type: 'error', message } });
    } finally {
      setBulkCloudSaving(false);
    }
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
            {cloudLoading && <div>Cargando Supabase...</div>}
            {!cloudLoading && !!cloudStatus && <div style={{ color: cloudStatus.includes('No se pudo') ? 'var(--text-negative)' : 'var(--text-muted)' }}>{cloudStatus}</div>}
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

          <span className="sidebar-section-title">Mercado</span>
          <button
            className={`nav-item ${currentPage === 'mercado' ? 'active' : ''}`}
            onClick={() => setCurrentPage('mercado')}
          >
            <span className="nav-icon">📈</span>
            Mercado IOL
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
          <button
            onClick={() => { if (window.confirm('¿Seguro que querés borrar TODOS los datos? Esta acción no se puede deshacer.')) { dispatch({ type: 'CLEAR_ALL_DATA' }); window.location.reload(); } }}
            className="nav-item"
            style={{ width: '100%', justifyContent: 'flex-start', color: 'var(--color-danger)', background: 'none', border: 'none', cursor: 'pointer', marginTop: '4px', fontSize: '12px' }}
          >
            <span className="nav-icon">🗑️</span>
            Limpiar Datos
          </button>
          {isAdmin && (
            <button
              onClick={handleBulkCloudSync}
              className="nav-item"
              disabled={bulkCloudSaving}
              style={{ width: '100%', justifyContent: 'flex-start', color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', marginTop: '4px', fontSize: '12px', opacity: bulkCloudSaving ? 0.7 : 1 }}
            >
              <span className="nav-icon">â˜ï¸</span>
              {bulkCloudSaving ? 'Subiendo a Supabase...' : 'Subir clientes locales'}
            </button>
          )}
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '12px' }}>
            <div>v0.3.5 • Conectado a Vercel</div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {currentPage === 'dashboard' && (
          <DashboardPage clients={clients} totalAUM={totalAUM} totalClients={totalClients} onNavigate={navigateToClient} currency={state.selectedCurrency} dispatch={dispatch} ratesHistory={state.ratesHistory} />
        )}
        {currentPage === 'clients' && (
          <ClientsPage clients={clients} onNavigate={navigateToClient} currency={state.selectedCurrency} dispatch={dispatch} ratesHistory={state.ratesHistory} />
        )}
        {currentPage === 'client-detail' && selectedClient && (
          <ClientDetailPage
            client={state.clients[selectedClient]}
            tab={clientTab}
            setTab={setClientTab}
            onBack={() => setCurrentPage('clients')}
            currency={state.selectedCurrency}
            dispatch={dispatch}
            ratesHistory={state.ratesHistory}
          />
        )}
        {currentPage === 'upload' && <UploadPage dispatch={dispatch} clients={clients} ratesHistory={state.ratesHistory} />}
        {currentPage === 'mercado' && <MercadoPage />}

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
function DashboardPage({ clients, totalAUM, totalClients, onNavigate, currency, dispatch, ratesHistory }) {
  const convertValue = (val) => {
    // Para AUM global, asumimos que totalAUM ya está en ARS. 
    // Para mostrarlo en USD, tomamos el TC del día o el último disponible globalmente (acá usamos el TC más reciente guardado en ratesHistory como proxy)
    const allDates = Object.keys(ratesHistory || {}).sort().reverse();
    const latestGlobalRate = allDates.length > 0 ? getMepRate(ratesHistory[allDates[0]]) : null;

    if (currency === 'USD' && latestGlobalRate) return val / latestGlobalRate;
    if (currency === 'USD_CCL' && latestGlobalRate) return val / latestGlobalRate;
    return val;
  };
  const currLabel = currency === 'ARS' ? 'ARS' : currency === 'USD' ? 'USD' : 'USD CCL';
  const currPrefix = currency === 'ARS' ? 'ARS' : 'USD';

  // Top clients by portfolio value
  const topClients = [...clients]
    .filter(c => c.snapshots.length > 0)
    .map(c => {
      const tirFlowKeys = c.tirFlowKeys || [];
      const latestSnapshot = c.snapshots[c.snapshots.length - 1];
      const latestUsdRate = getMepRate(getRateForDate(ratesHistory, latestSnapshot?.date)) || 1;
      const deposits = getTotalDeposits(c.movements);
      const withdrawals = getTotalWithdrawals(c.movements);
      const portfolioValue = currency === 'ARS'
        ? (latestSnapshot?.totalValue || 0) + ((latestSnapshot?.availableDolares || 0) * latestUsdRate)
        : latestUsdRate > 0
          ? ((latestSnapshot?.totalValue || 0) + ((latestSnapshot?.availableDolares || 0) * latestUsdRate)) / latestUsdRate
          : (latestSnapshot?.totalValue || 0);
      const selectedMovFlows = (c.movements || [])
        .filter(m => (m.classification === 'DEPOSIT' || m.classification === 'WITHDRAWAL') && tirFlowKeys.includes(`${m.concertDate}|${m.movNumber}|${m.monto}`))
        .map(m => ({
          date: m.concertDate,
          amount: m.classification === 'DEPOSIT' ? Math.abs(m.monto) : -Math.abs(m.monto),
          currency: m.moneda || 'ARS',
        }));
      const allFlows = [...selectedMovFlows, ...(c.manualFlows || [])];
      const perf = calculatePerformance(c.snapshots, c.movements, ratesHistory, currency === 'USD_CCL' ? 'USD' : currency, allFlows);
      return {
        ...c,
        latestValue: c.snapshots[c.snapshots.length - 1]?.totalValue || 0,
        twr: perf.totalReturn,
        nominalGain: getNominalGainValue(portfolioValue, deposits, withdrawals, currency, latestUsdRate),
      };
    })
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
                  <th className="text-right">Ganancia Neta</th>
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
                    <td className={`text-right ${c.nominalGain >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {formatCurrency(c.nominalGain, currPrefix)}
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
function ClientsPage({ clients, onNavigate, currency, dispatch, ratesHistory }) {
  const [search, setSearch] = useState('');

  const getSnapshotArsValue = (snapshot) => {
    if (!snapshot) return 0;
    const rate = getMepRate(getRateForDate(ratesHistory, snapshot.date)) || 1;
    return snapshot.totalValue + (snapshot.availableDolares * rate);
  };

  const getSnapshotUsdValue = (snapshot) => {
    if (!snapshot) return 0;
    const rate = getMepRate(getRateForDate(ratesHistory, snapshot.date)) || 1;
    const totalArs = snapshot.totalValue + (snapshot.availableDolares * rate);
    return rate > 1 ? totalArs / rate : totalArs;
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
            const cTirKeys = c.tirFlowKeys || [];
            const cSelectedFlows = (c.movements || [])
              .filter(m => (m.classification === 'DEPOSIT' || m.classification === 'WITHDRAWAL') && cTirKeys.includes(`${m.concertDate}|${m.movNumber}|${m.monto}`))
              .map(m => ({ date: m.concertDate, amount: m.classification === 'DEPOSIT' ? Math.abs(m.monto) : -Math.abs(m.monto), currency: m.moneda || 'ARS' }));
            const cAllFlows = [...cSelectedFlows, ...(c.manualFlows || [])];
            const perf = calculatePerformance(c.snapshots, c.movements, ratesHistory, currency === 'USD_CCL' ? 'USD' : currency, cAllFlows);
            const deposits = getTotalDeposits(c.movements);
            const withdrawals = getTotalWithdrawals(c.movements);
            const latestUsdRate = getMepRate(getRateForDate(ratesHistory, latest?.date)) || 1;
            const portfolioValue = currency === 'ARS' ? getSnapshotArsValue(latest) : getSnapshotUsdValue(latest);
            const nominalGain = getNominalGainValue(portfolioValue, deposits, withdrawals, currency, latestUsdRate);

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
                      {formatCurrency(currency === 'ARS' ? getSnapshotArsValue(latest) : getSnapshotUsdValue(latest), currPrefix)}
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
                    <div className="client-stat-label">Ganancia Neta</div>
                    <div className="client-stat-value" style={{ color: nominalGain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                      {formatCurrency(nominalGain, currPrefix)}
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
                      <FlowDisplay flow={deposits} currPrefix={currPrefix} usdRate={latestUsdRate} />
                    </div>
                  </div>
                  <div className="client-stat">
                    <div className="client-stat-label">Egresos</div>
                    <div className="client-stat-value" style={{ fontSize: '13px', color: 'var(--color-danger)' }}>
                      <FlowDisplay flow={withdrawals} currPrefix={currPrefix} usdRate={latestUsdRate} />
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
function ClientDetailPage({ client, tab, setTab, onBack, currency, dispatch, ratesHistory }) {
  if (!client) return null;

  const getSnapshotArsValue = (snapshot) => {
    if (!snapshot) return 0;
    const rate = getMepRate(getRateForDate(ratesHistory, snapshot.date)) || 1;
    return snapshot.totalValue + (snapshot.availableDolares * rate);
  };

  const getSnapshotUsdValue = (snapshot) => {
    if (!snapshot) return 0;
    const rate = getMepRate(getRateForDate(ratesHistory, snapshot.date)) || 1;
    const totalArs = snapshot.totalValue + (snapshot.availableDolares * rate);
    return rate > 1 ? totalArs / rate : totalArs;
  };

  const currPrefix = currency === 'ARS' ? 'ARS' : 'USD';
  const currLabel = currency === 'ARS' ? 'ARS' : currency === 'USD' ? 'USD' : 'USD CCL';

  const latest = client.snapshots[client.snapshots.length - 1];

  // Build combined flows: selected movements + manual flows
  const tirFlowKeys = client.tirFlowKeys || [];
  const selectedMovFlows = (client.movements || [])
    .filter(m => (m.classification === 'DEPOSIT' || m.classification === 'WITHDRAWAL') && tirFlowKeys.includes(`${m.concertDate}|${m.movNumber}|${m.monto}`))
    .map(m => ({
      date: m.concertDate,
      amount: m.classification === 'DEPOSIT' ? Math.abs(m.monto) : -Math.abs(m.monto),
      currency: m.moneda || 'ARS',
    }));
  const allFlows = [...selectedMovFlows, ...(client.manualFlows || [])];

  const perf = calculatePerformance(client.snapshots, client.movements, ratesHistory, currency === 'USD_CCL' ? 'USD' : currency, allFlows);
  const totalDeposits = getTotalDeposits(client.movements);
  const totalWithdrawals = getTotalWithdrawals(client.movements);
  const latestUsdRate = getMepRate(getRateForDate(ratesHistory, latest?.date)) || 1;
  const currentPortfolioValue = currency === 'ARS' ? getSnapshotArsValue(latest) : getSnapshotUsdValue(latest);
  const nominalGain = getNominalGainValue(currentPortfolioValue, totalDeposits, totalWithdrawals, currency, latestUsdRate);

  const convertValue = (val) => {
    if (currency === 'USD' || currency === 'USD_CCL') return val / latestUsdRate;
    return val;
  };

  // Color palette for holdings
  const holdingColors = ['#6366f1', '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];

  const [savingLoading, setSavingLoading] = useState(false);
  const [assignedEmail, setAssignedEmail] = useState(client.assignedEmail || '');

  const saveToCloud = async () => {
    setSavingLoading(true);
    try {
      await upsertClientToCloud(client, assignedEmail);

      dispatch({ type: 'ADD_TOAST', payload: { type: 'success', title: '¡Guardado!', message: 'Datos respaldados en la nube.' } });
    } catch (err) {
      console.error(err);
      dispatch({ type: 'ADD_TOAST', payload: { type: 'error', title: 'Error', message: 'No se pudo guardar en Supabase.' } });
    } finally {
      setSavingLoading(false);
    }
  };

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

      <div className="card" style={{ marginBottom: '24px', backgroundColor: 'rgba(99, 102, 241, 0.05)', border: '1px solid var(--color-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <h3 style={{ fontSize: '14px', marginBottom: '4px' }}>☁️ Conexión a Nube (Portal de Inversores)</h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Asigná el email del cliente para que pueda ver esta cuenta en su celular.</p>
          </div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <input
              type="email"
              placeholder="Email del cliente (ej: juan@gmail.com)"
              value={assignedEmail}
              onChange={(e) => setAssignedEmail(e.target.value)}
              className="search-input"
              style={{ width: '250px' }}
            />
            <button
              onClick={saveToCloud}
              className="btn btn-primary"
              disabled={savingLoading}
            >
              {savingLoading ? 'Guardando...' : 'Sincronizar a Nube'}
            </button>
          </div>
        </div>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="stat-card accent-blue">
          <div className="stat-label">Cartera ({currLabel})</div>
          <div className="stat-value" style={{ fontSize: '20px' }}>
            {formatCurrency(currentPortfolioValue, currPrefix)}
          </div>
        </div>
        <div className="stat-card accent-amber">
          <div className="stat-label">Ganancia Neta</div>
          <div className="stat-value" style={{ fontSize: '20px', color: nominalGain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {formatCurrency(nominalGain, currPrefix)}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>Cartera menos aportes netos</div>
        </div>
        <div className="stat-card accent-green">
          <div className="stat-label">TIR Total</div>
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
          <div className="stat-label">TIR YTD {new Date().getFullYear()}</div>
          <div className="stat-value" style={{ fontSize: '20px', color: perf.ytdReturn !== null ? (perf.ytdReturn >= 0 ? 'var(--color-success)' : 'var(--color-danger)') : 'inherit' }}>
            {perf.ytdReturn !== null ? formatPercent(perf.ytdReturn) : 'N/A'}
          </div>
          {perf.endDate && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>Al {perf.endDate}</div>
          )}
        </div>
        <div className="stat-card accent-purple">
          <div className="stat-label">TIR {new Date().getFullYear() - 1}</div>
          <div className="stat-value" style={{ fontSize: '20px', color: perf.prevYearReturn !== null ? (perf.prevYearReturn >= 0 ? 'var(--color-success)' : 'var(--color-danger)') : 'inherit' }}>
            {perf.prevYearReturn !== null ? formatPercent(perf.prevYearReturn) : 'N/A'}
          </div>
        </div>
        <div className="stat-card accent-amber">
          <div className="stat-label">Total Ingresos</div>
          <div className="stat-value" style={{ fontSize: '18px', color: 'var(--color-success)' }}>
            <FlowDisplay flow={totalDeposits} currPrefix={currPrefix} usdRate={latestUsdRate} />
          </div>
        </div>
        <div className="stat-card" style={{ borderLeft: '3px solid var(--color-danger)' }}>
          <div className="stat-label">Total Egresos</div>
          <div className="stat-value" style={{ fontSize: '18px', color: 'var(--color-danger)' }}>
            <FlowDisplay flow={totalWithdrawals} currPrefix={currPrefix} usdRate={latestUsdRate} />
          </div>
        </div>
      </div>

      <div className="tabs" style={{ display: 'flex', gap: '8px', overflowX: 'auto', flexWrap: 'nowrap' }}>
        <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>
          Posiciones
        </button>
        <button className={`tab ${tab === 'movements' ? 'active' : ''}`} onClick={() => setTab('movements')}>
          Movimientos ({client.movements.length})
        </button>
        <button className={`tab ${tab === 'snapshots' ? 'active' : ''}`} onClick={() => setTab('snapshots')}>
          Historial ({client.snapshots.length})
        </button>
        <button className={`tab ${tab === 'rates' ? 'active' : ''}`} onClick={() => setTab('rates')}>
          Cotizaciones
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

      {tab === 'rates' && (
        <ClientRatesTab client={client} ratesHistory={ratesHistory} dispatch={dispatch} />
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
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {[...client.snapshots].reverse().map((s, i) => (
                    <tr key={`${s.date}-${i}`}>
                      <td className="text-bold">{s.date}</td>
                      <td className="text-right text-bold">{formatCurrency(currency === 'ARS' ? getSnapshotArsValue(s) : getSnapshotUsdValue(s), currPrefix)}</td>
                      <td className="text-right">{s.holdings?.length || 0}</td>
                      <td className="text-right">{formatCurrency(s.availablePesos, 'ARS')}</td>
                      <td className="text-right">{formatCurrency(s.availableDolares, 'USD')}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--color-danger)', fontSize: '12px' }}
                          onClick={() => {
                            if (confirm(`¿Eliminar snapshot del ${s.date}?`)) {
                              dispatch({ type: 'DELETE_SNAPSHOT', payload: { accountNumber: client.accountNumber, date: s.date } });
                              dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `Snapshot del ${s.date} eliminado` } });
                            }
                          }}
                        >
                          🗑️
                        </button>
                      </td>
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
// MOVEMENT FLOW SELECTOR — Select which movements count for TIR
// ===================================================
function MovementFlowSelector({ client, dispatch, manualInputs, setManualInputs }) {
  const depositWithdrawals = (client.movements || [])
    .filter(m => m.classification === 'DEPOSIT' || m.classification === 'WITHDRAWAL')
    .sort((a, b) => (a.concertDate || '').localeCompare(b.concertDate || ''));
  const tirKeys = client.tirFlowKeys || [];
  const selectedCount = depositWithdrawals.filter(m => tirKeys.includes(`${m.concertDate}|${m.movNumber}|${m.monto}`)).length;

  return (
    <div className="card" style={{ marginTop: '16px' }}>
      <div className="card-header">
        <div>
          <div className="card-title">💸 Flujos para TIR ({selectedCount} seleccionados de {depositWithdrawals.length})</div>
          <div className="card-subtitle">
            Seleccioná solo los depósitos y retiros REALES (transferencias bancarias).
            No tildes operaciones MEP internas (donde se deposita en una moneda y se retira en otra).
          </div>
        </div>
      </div>

      {depositWithdrawals.length > 0 ? (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th style={{ width: '40px' }}>TIR</th>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Descripción</th>
                <th>Moneda</th>
                <th className="text-right">Monto</th>
              </tr>
            </thead>
            <tbody>
              {depositWithdrawals.map((m, idx) => {
                const movKey = `${m.concertDate}|${m.movNumber}|${m.monto}`;
                const isSelected = tirKeys.includes(movKey);
                const isDep = m.classification === 'DEPOSIT';
                return (
                  <tr key={`${movKey}_${idx}`}
                    style={{ background: isSelected ? 'rgba(99,102,241,0.08)' : 'transparent', cursor: 'pointer' }}
                    onClick={() => dispatch({ type: 'TOGGLE_TIR_FLOW', payload: { accountNumber: client.accountNumber, movKey } })}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={isSelected}
                        onChange={() => dispatch({ type: 'TOGGLE_TIR_FLOW', payload: { accountNumber: client.accountNumber, movKey } })}
                        style={{ cursor: 'pointer', width: '16px', height: '16px' }} />
                    </td>
                    <td className="text-bold">{m.concertDate}</td>
                    <td>
                      {isDep
                        ? <span className="badge badge-success">Depósito</span>
                        : <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>Retiro</span>}
                    </td>
                    <td style={{ fontSize: '12px', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.tipoMov}
                    </td>
                    <td><span className="badge badge-info">{m.moneda}</span></td>
                    <td className="text-right" style={{ color: isDep ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600 }}>
                      {isDep ? '+' : '-'}{Math.abs(m.monto).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          No hay depósitos ni retiros en los movimientos cargados. Cargá un archivo de movimientos primero.
        </div>
      )}

      {/* Mini form for manual flows */}
      <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
          ¿Falta algún flujo en la lista? Agregalo manualmente:
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" className="search-input" style={{ width: '140px', padding: '6px 8px', fontSize: '12px' }}
            value={manualInputs._flowDate || ''} onChange={(e) => setManualInputs({ ...manualInputs, _flowDate: e.target.value })} />
          <input type="text" className="search-input" style={{ width: '130px', padding: '6px 8px', fontSize: '12px' }}
            placeholder="Monto (+dep / -ret)" value={manualInputs._flowAmount || ''} onChange={(e) => setManualInputs({ ...manualInputs, _flowAmount: e.target.value })} />
          <select className="search-input" style={{ width: '70px', padding: '6px 8px', fontSize: '12px' }}
            value={manualInputs._flowCurrency || 'USD'} onChange={(e) => setManualInputs({ ...manualInputs, _flowCurrency: e.target.value })}>
            <option value="USD">USD</option>
            <option value="ARS">ARS</option>
          </select>
          <button className="btn btn-secondary btn-sm" style={{ fontSize: '12px', padding: '6px 12px' }}
            onClick={() => {
              const dateVal = manualInputs._flowDate;
              const rawAmt = (manualInputs._flowAmount || '').replace(/\./g, '').replace(/,/g, '.');
              const amount = parseFloat(rawAmt);
              const cur = manualInputs._flowCurrency || 'USD';
              if (!dateVal || isNaN(amount) || amount === 0) {
                dispatch({ type: 'ADD_TOAST', payload: { type: 'error', message: 'Fecha y monto válido requeridos.' } });
                return;
              }
              dispatch({ type: 'ADD_MANUAL_FLOW', payload: { accountNumber: client.accountNumber, flow: { date: dateVal, amount, currency: cur, description: 'Manual' } } });
              setManualInputs((prev) => ({ ...prev, _flowDate: '', _flowAmount: '' }));
              dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `Flujo manual ${amount > 0 ? '+' : ''}${amount.toFixed(2)} ${cur} agregado` } });
            }}>
            ➕ Agregar
          </button>
        </div>
        {(client.manualFlows || []).length > 0 && (
          <div style={{ marginTop: '8px' }}>
            {(client.manualFlows || []).map(f => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '4px 0' }}>
                <span className="text-bold">{f.date}</span>
                <span style={{ color: f.amount > 0 ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600 }}>
                  {f.amount > 0 ? '+' : ''}{Math.abs(f.amount).toLocaleString('es-AR', { minimumFractionDigits: 2 })} {f.currency || 'USD'}
                </span>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--color-danger)', fontSize: '10px', padding: '2px 6px' }}
                  onClick={() => dispatch({ type: 'DELETE_MANUAL_FLOW', payload: { accountNumber: client.accountNumber, flowId: f.id } })}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ===================================================
// CLIENT RATES TAB — Manual exchange rates + external flows
// ===================================================
function ClientRatesTab({ client, ratesHistory, dispatch }) {
  // Dates from snapshots, selected movements, AND manual flows that need rates
  const snapshotDates = (client.snapshots || []).map(s => s.date).filter(Boolean);
  const flowDates = (client.manualFlows || []).map(f => f.date).filter(Boolean);
  const tirKeys = client.tirFlowKeys || [];
  const selectedMovDates = (client.movements || [])
    .filter(m => (m.classification === 'DEPOSIT' || m.classification === 'WITHDRAWAL') && tirKeys.includes(`${m.concertDate}|${m.movNumber}|${m.monto}`))
    .map(m => m.concertDate).filter(Boolean);
  const allDates = [...new Set([...snapshotDates, ...flowDates, ...selectedMovDates])];
  const sortedDates = allDates.sort().reverse();

  const [manualInputs, setManualInputs] = useState({});

  // Count how many dates are missing a rate
  const missingCount = sortedDates.filter(d => !getMepRate(getRateForDate(ratesHistory, d))).length;

  const handleSaveRate = (date) => {
    let rawVal = (manualInputs[date] || '').trim();
    if (!rawVal) return;

    // Si tiene comas y puntos (ej 1.300,50 o 1,300.50), limpiamos el de "miles"
    if (rawVal.includes('.') && rawVal.includes(',')) {
      if (rawVal.indexOf('.') < rawVal.indexOf(',')) {
        // Formato 1.300,50
        rawVal = rawVal.replace(/\./g, '').replace(/,/g, '.');
      } else {
        // Formato 1,300.50
        rawVal = rawVal.replace(/,/g, '');
      }
    } else {
      // Si solo tiene coma o solo tiene punto, lo tratamos como decimal
      rawVal = rawVal.replace(/,/g, '.');
    }

    const rate = parseFloat(rawVal);

    if (!isNaN(rate) && rate > 0) {
      dispatch({
        type: 'ADD_MANUAL_RATE',
        payload: { date, rate }
      });
      setManualInputs((prev) => ({ ...prev, [date]: '' }));
      dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `TC del ${date} guardado: $${rate.toLocaleString('es-AR')}` } });
    } else {
      dispatch({ type: 'ADD_TOAST', payload: { type: 'error', message: 'Ingresá un valor válido mayor a 0.' } });
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">💱 Tipo de Cambio por Fecha de Tenencia</div>
            <div className="card-subtitle">
              Ingresá el TC del dólar MEP para cada fecha de reporte de tenencia.
              El rendimiento se calcula usando estos valores.
            </div>
          </div>
        </div>

        {missingCount > 0 && (
          <div style={{ margin: '0 20px 16px', padding: '12px 16px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 'var(--radius-sm)', fontSize: '13px', color: '#f59e0b' }}>
            ⚠️ <strong>Faltan {missingCount} cotización{missingCount > 1 ? 'es' : ''}.</strong> Ingresá el TC para que el rendimiento se calcule correctamente.
          </div>
        )}

        {sortedDates.length === 0 ? (
          <div className="empty-state" style={{ padding: '32px' }}>
            <div className="empty-state-icon" style={{ fontSize: '36px' }}>📸</div>
            <div className="empty-state-title" style={{ fontSize: '15px' }}>Sin tenencias cargadas</div>
            <div className="empty-state-text" style={{ fontSize: '13px' }}>
              Cargá al menos dos archivos de tenencia de distintas fechas para poder ingresar cotizaciones.
            </div>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Fecha Tenencia</th>
                  <th>TC Actual</th>
                  <th>Estado</th>
                  <th>Ingresar TC (USD MEP)</th>
                </tr>
              </thead>
              <tbody>
                {sortedDates.map((date) => {
                  const rateObj = getRateForDate(ratesHistory, date);
                  const usedRate = getMepRate(rateObj);
                  const hasRate = usedRate !== null && usedRate > 0;
                  const isManual = ratesHistory[date]?.isManual;
                  const isSnapshotDate = snapshotDates.includes(date);
                  const isFlowDate = flowDates.includes(date);

                  return (
                    <tr key={date} style={{ background: !hasRate ? 'rgba(245,158,11,0.05)' : 'transparent' }}>
                      <td className="text-bold">
                        {date}
                        {isSnapshotDate && <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>📸</span>}
                        {isFlowDate && <span style={{ marginLeft: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>💸</span>}
                      </td>
                      <td>
                        {hasRate
                          ? <span style={{ color: 'var(--color-success)' }}>$ {usedRate.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          : <span style={{ color: '#f59e0b' }}>— Sin cargar</span>}
                      </td>
                      <td>
                        {!hasRate ? (
                          <span className="badge badge-warning">⚠️ Pendiente</span>
                        ) : (
                          <span className="badge badge-success">✅ Manual</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <input
                            type="text"
                            className="search-input"
                            style={{ width: '130px', padding: '6px 10px', fontSize: '14px', border: !hasRate ? '2px solid #f59e0b' : undefined }}
                            placeholder={hasRate ? 'Actualizar...' : '⚠ Completar TC'}
                            value={manualInputs[date] !== undefined ? manualInputs[date] : (hasRate ? usedRate.toString().replace('.', ',') : '')}
                            onChange={(e) => setManualInputs({ ...manualInputs, [date]: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleSaveRate(date); }}
                          />
                          <button
                            className={`btn ${!hasRate ? 'btn-primary' : 'btn-secondary'} btn-sm`}
                            onClick={() => handleSaveRate(date)}
                          >
                            {!hasRate ? 'Guardar' : 'Cambiar'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* === SELECCIÓN DE FLUJOS PARA TIR === */}
      <MovementFlowSelector client={client} dispatch={dispatch} manualInputs={manualInputs} setManualInputs={setManualInputs} />
    </>
  );
}

// ===================================================
// UPLOAD PAGE
// ===================================================
function UploadPage({ dispatch, clients, ratesHistory }) {
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [unassignedMovements, setUnassignedMovements] = useState([]);

  const handleTenenciaUpload = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setProcessing(true);
    const datesToSync = new Set();

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
          if (parsed.date) datesToSync.add(parsed.date);
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

    if (datesToSync.size > 0) {
      try {
        const { syncedDates, skipped } = await syncHistoricalMepForDates([...datesToSync], ratesHistory, dispatch);
        if (!skipped) {
          dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `MEP histórico actualizado para ${syncedDates.length} fecha${syncedDates.length === 1 ? '' : 's'}.` } });
        }
      } catch (err) {
        dispatch({ type: 'ADD_TOAST', payload: { type: 'error', message: `No se pudieron actualizar cotizaciones IOL: ${err.message}` } });
      }
    }

    setProcessing(false);
    e.target.value = '';
  }, [dispatch, ratesHistory]);

  const handleMovimientosUpload = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setProcessing(true);
    const datesToSync = new Set();

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
        parsed.movements
          .filter(m => m.classification === 'DEPOSIT' || m.classification === 'WITHDRAWAL')
          .forEach(m => {
            if (m.concertDate) datesToSync.add(m.concertDate);
          });

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

    if (datesToSync.size > 0) {
      try {
        const { syncedDates, skipped } = await syncHistoricalMepForDates([...datesToSync], ratesHistory, dispatch);
        if (!skipped) {
          dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `MEP histórico actualizado para ${syncedDates.length} fecha${syncedDates.length === 1 ? '' : 's'}.` } });
        }
      } catch (err) {
        dispatch({ type: 'ADD_TOAST', payload: { type: 'error', message: `No se pudieron actualizar cotizaciones IOL: ${err.message}` } });
      }
    }

    setProcessing(false);
    e.target.value = '';
  }, [dispatch, clients, ratesHistory]);

  const assignMovements = async (index, accountNumber) => {
    const batch = unassignedMovements[index];
    dispatch({
      type: 'ASSIGN_MOVEMENTS',
      payload: { accountNumber, movements: batch.movements },
    });
    setUnassignedMovements(prev => prev.filter((_, i) => i !== index));
    dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `Movimientos asignados exitosamente` } });

    const flowDates = batch.movements
      .filter(m => m.classification === 'DEPOSIT' || m.classification === 'WITHDRAWAL')
      .map(m => m.concertDate)
      .filter(Boolean);

    if (flowDates.length > 0) {
      try {
        const { syncedDates, skipped } = await syncHistoricalMepForDates(flowDates, ratesHistory, dispatch);
        if (!skipped) {
          dispatch({ type: 'ADD_TOAST', payload: { type: 'success', message: `MEP histórico actualizado para ${syncedDates.length} fecha${syncedDates.length === 1 ? '' : 's'}.` } });
        }
      } catch (err) {
        dispatch({ type: 'ADD_TOAST', payload: { type: 'error', message: `No se pudieron actualizar cotizaciones IOL: ${err.message}` } });
      }
    }
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

// SettingsPage removed — rates are managed manually per client in the Cotizaciones tab

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
// MERCADO IOL PAGE
// ===================================================

/**
 * Detect settlement currency from IOL description, moneda field, and ticker
 * Priority: 1) Description text  2) Ticker suffix (when moneda=2)  3) moneda field
 * Returns: 'ARS' | 'USD MEP' | 'USD Cable' | 'USD'
 */
function detectSettlementCurrency(descripcion, monedaCode, simbolo) {
  const desc = (descripcion || '').toLowerCase();
  const ticker = (simbolo || '').toUpperCase();
  const isUSD = monedaCode === 2 || monedaCode === '2' || monedaCode === 'dolar_Estadounidense';

  // LAYER 1: Check description for explicit MEP/Cable mentions (most reliable for ONs)
  if (desc.includes('usd mep') || desc.includes('u$s mep') || desc.includes('dolar mep') || desc.includes('dlr mep')) {
    return 'USD MEP';
  }
  if (desc.includes('usdc') || desc.includes('usd cable') || desc.includes('u$s cable') || desc.includes('u$s cg') || desc.includes('dlr cable')) {
    return 'USD Cable';
  }

  // LAYER 2: If moneda = 1 (pesos), it's ALWAYS ARS regardless of ticker or description
  if (!isUSD) {
    return 'ARS';
  }

  // LAYER 3: moneda = 2 (USD) - use ticker suffix to differentiate MEP vs Cable
  // This is the standard BYMA convention and is safe because we already confirmed moneda=2
  const lastChar = ticker.slice(-1);
  if (lastChar === 'D') return 'USD MEP';
  if (lastChar === 'C') return 'USD Cable';

  // USD but no D/C suffix - rare, keep as generic USD
  return 'USD';
}

/** Get color for currency badge */
function currencyBadgeStyle(currency) {
  const base = {
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.5px',
    display: 'inline-block',
    whiteSpace: 'nowrap',
  };
  switch (currency) {
    case 'ARS': return { ...base, background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)' };
    case 'USD MEP': return { ...base, background: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', border: '1px solid rgba(34, 197, 94, 0.3)' };
    case 'USD Cable': return { ...base, background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', border: '1px solid rgba(168, 85, 247, 0.3)' };
    case 'USD': return { ...base, background: 'rgba(234, 179, 8, 0.15)', color: '#facc15', border: '1px solid rgba(234, 179, 8, 0.3)' };
    default: return { ...base, background: 'rgba(100,100,100,0.15)', color: '#999' };
  }
}

function MercadoPage() {
  const [activeTab, setActiveTab] = useState('bonos');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [requestCount, setRequestCount] = useState(0);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [search, setSearch] = useState('');
  const [currencyFilter, setCurrencyFilter] = useState('Todos');
  const [sortField, setSortField] = useState('simbolo');
  const [sortDir, setSortDir] = useState('asc');

  // Data for each tab
  const [bonos, setBonos] = useState([]);
  const [acciones, setAcciones] = useState([]);
  const [letras, setLetras] = useState([]);
  const [ons, setOns] = useState([]);
  const [cedears, setCedears] = useState([]);

  const tabConfig = {
    bonos: { label: 'Bonos', action: 'panel_bonos', data: bonos, setData: setBonos },
    acciones: { label: 'Acciones', action: 'panel_acciones', data: acciones, setData: setAcciones },
    letras: { label: 'Letras', action: 'panel_letras', data: letras, setData: setLetras },
    ons: { label: 'ONs', action: 'panel_obligaciones', data: ons, setData: setOns },
    cedears: { label: 'CEDEARs', action: 'panel_cedears', data: cedears, setData: setCedears },
  };

  // Tabs that show currency filter (not relevant for acciones/cedears)
  const showCurrencyFilter = ['bonos', 'letras', 'ons'].includes(activeTab);

  // Load persistent request count on mount (does NOT call IOL API)
  useEffect(() => {
    fetch('/api/iol', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_request_count' }),
    })
      .then(r => r.json())
      .then(json => {
        if (json.requestCount !== undefined) setRequestCount(json.requestCount);
      })
      .catch(() => { });
  }, []);

  const fetchPanel = async (tabKey) => {
    const config = tabConfig[tabKey];
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/iol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: config.action }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      const items = json.data?.titulos || json.data || [];
      config.setData(Array.isArray(items) ? items : []);
      setRequestCount(json.requestCount || 0);
      setLastUpdate(new Date().toLocaleTimeString('es-AR'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const currentData = tabConfig[activeTab]?.data || [];

  // Enrich data with settlement currency
  const enrichedData = currentData.map(item => ({
    ...item,
    _currency: detectSettlementCurrency(item.descripcion || item.description, item.moneda),
  }));

  // Currency filter
  const currencyFiltered = enrichedData.filter(item => {
    if (currencyFilter === 'Todos') return true;
    return item._currency === currencyFilter;
  });

  // Search filter
  const filtered = currencyFiltered.filter(item => {
    if (!search) return true;
    const q = search.toLowerCase();
    const sym = (item.simbolo || item.symbol || '').toLowerCase();
    const desc = (item.descripcion || item.description || '').toLowerCase();
    return sym.includes(q) || desc.includes(q);
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    const field = sortField === '_currency' ? '_currency' : sortField;
    const aVal = a[field] ?? '';
    const bVal = b[field] ?? '';
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    }
    return sortDir === 'asc'
      ? String(aVal).localeCompare(String(bVal))
      : String(bVal).localeCompare(String(aVal));
  });

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sortIcon = (field) => sortField === field ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const fmtNum = (n) => {
    if (n === null || n === undefined || n === '') return '-';
    return Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const fmtPct = (n) => {
    if (n === null || n === undefined || n === '') return '-';
    const v = Number(n);
    return (
      <span style={{ color: v >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
        {v >= 0 ? '+' : ''}{v.toFixed(2)}%
      </span>
    );
  };

  // Count per currency for the badge
  const currencyCounts = enrichedData.reduce((acc, item) => {
    acc[item._currency] = (acc[item._currency] || 0) + 1;
    return acc;
  }, {});

  const requestPct = ((requestCount / 20000) * 100).toFixed(1);

  return (
    <>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <h1>📈 Mercado IOL</h1>
            <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Datos de mercado en tiempo real vía InvertirOnline API</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{
              background: 'var(--bg-card)',
              borderRadius: '8px',
              padding: '8px 16px',
              border: '1px solid var(--border-color)',
              fontSize: '12px',
              textAlign: 'center',
            }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: '2px' }}>Requests este mes</div>
              <div style={{
                fontWeight: 700,
                fontSize: '16px',
                color: requestCount > 18000 ? 'var(--color-danger)' : requestCount > 15000 ? 'var(--color-warning)' : 'var(--color-success)',
              }}>
                {requestCount.toLocaleString()} / 20.000
              </div>
              <div style={{
                width: '100%',
                height: '4px',
                background: 'var(--bg-secondary)',
                borderRadius: '2px',
                marginTop: '4px',
                overflow: 'hidden',
              }}>
                <div style={{
                  width: `${Math.min(requestPct, 100)}%`,
                  height: '100%',
                  background: requestCount > 18000 ? 'var(--color-danger)' : requestCount > 15000 ? '#f59e0b' : 'var(--color-success)',
                  borderRadius: '2px',
                  transition: 'width 0.5s ease',
                }} />
              </div>
            </div>
            <button
              onClick={() => fetchPanel(activeTab)}
              disabled={loading}
              className="btn btn-primary"
              style={{ padding: '10px 20px', fontSize: '14px' }}
            >
              {loading ? '⏳ Cargando...' : '🔄 Actualizar'}
            </button>
          </div>
        </div>
      </div>

      {lastUpdate && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
          Última actualización: {lastUpdate}
        </div>
      )}

      {error && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid var(--color-danger)',
          borderRadius: '8px',
          padding: '12px 16px',
          marginBottom: '16px',
          color: 'var(--color-danger)',
          fontSize: '14px',
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* Tabs */}
      <div className="tabs" style={{ marginBottom: '16px' }}>
        {Object.keys(tabConfig).map(key => (
          <button
            key={key}
            className={`tab ${activeTab === key ? 'active' : ''}`}
            onClick={() => { setActiveTab(key); setSearch(''); setCurrencyFilter('Todos'); }}
          >
            {tabConfig[key].label}
            {tabConfig[key].data.length > 0 && (
              <span style={{ marginLeft: '6px', fontSize: '11px', opacity: 0.6 }}>
                ({tabConfig[key].data.length})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Filters row */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="🔍 Buscar por ticker o descripción..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
          style={{ maxWidth: '350px', flex: 1 }}
        />
        {showCurrencyFilter && enrichedData.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginRight: '4px' }}>Moneda:</span>
            {['Todos', 'ARS', 'USD MEP', 'USD Cable', 'USD'].map(opt => {
              const count = opt === 'Todos' ? enrichedData.length : (currencyCounts[opt] || 0);
              if (opt !== 'Todos' && count === 0) return null;
              return (
                <button
                  key={opt}
                  onClick={() => setCurrencyFilter(opt)}
                  style={{
                    padding: '4px 12px',
                    borderRadius: '6px',
                    border: currencyFilter === opt ? '1px solid var(--color-primary)' : '1px solid var(--border-color)',
                    background: currencyFilter === opt ? 'rgba(124, 58, 237, 0.15)' : 'var(--bg-card)',
                    color: currencyFilter === opt ? 'var(--color-primary)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: currencyFilter === opt ? 600 : 400,
                    transition: 'all 0.2s ease',
                  }}
                >
                  {opt} <span style={{ opacity: 0.5, fontSize: '10px' }}>({count})</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="card">
        {sorted.length === 0 && !loading ? (
          <div className="empty-state">
            <div className="empty-state-icon">📊</div>
            <div className="empty-state-title">
              {currentData.length === 0 ? 'Sin datos' : 'Sin resultados'}
            </div>
            <div className="empty-state-text">
              {currentData.length === 0
                ? 'Apretá el botón "🔄 Actualizar" para traer los datos del mercado.'
                : `No se encontraron títulos para los filtros seleccionados`
              }
            </div>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th style={{ cursor: 'pointer' }} onClick={() => handleSort('simbolo')}>
                    Ticker{sortIcon('simbolo')}
                  </th>
                  <th style={{ cursor: 'pointer' }} onClick={() => handleSort('descripcion')}>
                    Descripción{sortIcon('descripcion')}
                  </th>
                  {showCurrencyFilter && (
                    <th style={{ cursor: 'pointer', textAlign: 'center' }} onClick={() => handleSort('_currency')}>
                      Moneda{sortIcon('_currency')}
                    </th>
                  )}
                  <th className="text-right" style={{ cursor: 'pointer' }} onClick={() => handleSort('ultimoPrecio')}>
                    Último{sortIcon('ultimoPrecio')}
                  </th>
                  <th className="text-right" style={{ cursor: 'pointer' }} onClick={() => handleSort('variacionPorcentual')}>
                    Var %{sortIcon('variacionPorcentual')}
                  </th>
                  <th className="text-right" style={{ cursor: 'pointer' }} onClick={() => handleSort('apertura')}>
                    Apertura{sortIcon('apertura')}
                  </th>
                  <th className="text-right" style={{ cursor: 'pointer' }} onClick={() => handleSort('maximo')}>
                    Máximo{sortIcon('maximo')}
                  </th>
                  <th className="text-right" style={{ cursor: 'pointer' }} onClick={() => handleSort('minimo')}>
                    Mínimo{sortIcon('minimo')}
                  </th>
                  <th className="text-right" style={{ cursor: 'pointer' }} onClick={() => handleSort('volumen')}>
                    Volumen{sortIcon('volumen')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((item, idx) => (
                  <tr key={item.simbolo || idx}>
                    <td>
                      <span className="ticker-tag">{item.simbolo || item.symbol || '-'}</span>
                    </td>
                    <td style={{ fontSize: '12px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.descripcion || item.description || '-'}
                    </td>
                    {showCurrencyFilter && (
                      <td style={{ textAlign: 'center' }}>
                        <span style={currencyBadgeStyle(item._currency)}>{item._currency}</span>
                      </td>
                    )}
                    <td className="text-right text-bold">{fmtNum(item.ultimoPrecio)}</td>
                    <td className="text-right">{fmtPct(item.variacionPorcentual)}</td>
                    <td className="text-right">{fmtNum(item.apertura)}</td>
                    <td className="text-right">{fmtNum(item.maximo)}</td>
                    <td className="text-right">{fmtNum(item.minimo)}</td>
                    <td className="text-right">{fmtNum(item.volumen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div style={{ marginTop: '12px', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'right' }}>
        {sorted.length > 0 && `Mostrando ${sorted.length} de ${currentData.length} títulos`}
      </div>
    </>
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
