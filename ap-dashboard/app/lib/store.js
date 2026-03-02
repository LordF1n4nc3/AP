'use client';

import { createContext, useContext, useReducer, useCallback } from 'react';

const AppContext = createContext(null);

const initialState = {
    clients: {},       // { accountNumber: { name, address, accountNumber, refNumber, snapshots: [], movements: [] } }
    toasts: [],
    selectedCurrency: 'ARS', // ARS, USD, USD_CCL
    usdRate: null,     // current USD MEP rate (venta)
    cclRate: null,     // current USD CCL rate (venta)
    ratesHistory: {},  // { 'YYYY-MM-DD': { mep: { compra, venta }, ccl: { compra, venta } } }
    ratesLastFetch: null, // ISO timestamp of last fetch
};

function reducer(state, action) {
    switch (action.type) {
        case 'ADD_SNAPSHOT': {
            const { accountNumber, data } = action.payload;
            const existing = state.clients[accountNumber] || {
                name: data.name,
                address: data.address,
                accountNumber: data.accountNumber,
                refNumber: data.refNumber,
                snapshots: [],
                movements: [],
            };
            // Avoid duplicate snapshots (same date)
            const hasSameDate = existing.snapshots.some(s => s.date === data.date);
            if (hasSameDate) {
                // Update existing snapshot
                existing.snapshots = existing.snapshots.map(s =>
                    s.date === data.date ? { ...s, ...data.snapshot } : s
                );
            } else {
                existing.snapshots = [...existing.snapshots, data.snapshot].sort(
                    (a, b) => new Date(a.date) - new Date(b.date)
                );
            }
            // Update client name/address in case it changed
            existing.name = data.name;
            existing.address = data.address;
            return {
                ...state,
                clients: { ...state.clients, [accountNumber]: { ...existing } },
            };
        }

        case 'ADD_MOVEMENTS': {
            const { accountNumber, movements } = action.payload;
            const existing = state.clients[accountNumber];
            if (!existing) return state;
            // Merge movements, avoiding duplicates by movNumber
            const existingIds = new Set(existing.movements.map(m => m.movNumber));
            const newMovements = movements.filter(m => !existingIds.has(m.movNumber));
            existing.movements = [...existing.movements, ...newMovements].sort(
                (a, b) => new Date(a.concertDate) - new Date(b.concertDate)
            );
            return {
                ...state,
                clients: { ...state.clients, [accountNumber]: { ...existing } },
            };
        }

        case 'ASSIGN_MOVEMENTS': {
            const { accountNumber, movements } = action.payload;
            const existing = state.clients[accountNumber];
            if (!existing) return state;
            const existingIds = new Set(existing.movements.map(m => m.movNumber));
            const newMovements = movements.filter(m => !existingIds.has(m.movNumber));
            return {
                ...state,
                clients: {
                    ...state.clients,
                    [accountNumber]: {
                        ...existing,
                        movements: [...existing.movements, ...newMovements].sort(
                            (a, b) => new Date(a.concertDate) - new Date(b.concertDate)
                        ),
                    },
                },
            };
        }

        case 'SET_CURRENCY':
            return { ...state, selectedCurrency: action.payload };

        case 'SET_RATES':
            return { ...state, usdRate: action.payload.usd, cclRate: action.payload.ccl };

        case 'SET_RATES_HISTORY': {
            const merged = { ...state.ratesHistory, ...action.payload.ratesByDate };
            return {
                ...state,
                ratesHistory: merged,
                ratesLastFetch: new Date().toISOString(),
            };
        }

        case 'ADD_TOAST':
            return { ...state, toasts: [...state.toasts, { id: Date.now(), ...action.payload }] };

        case 'REMOVE_TOAST':
            return { ...state, toasts: state.toasts.filter(t => t.id !== action.payload) };

        case 'LOAD_STATE':
            return { ...action.payload, toasts: [] };

        default:
            return state;
    }
}

// Persistence
const STORAGE_KEY = 'ap-dashboard-data';

function loadFromStorage() {
    if (typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to load from storage', e);
    }
    return null;
}

function saveToStorage(state) {
    if (typeof window === 'undefined') return;
    try {
        const { toasts, ...rest } = state;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch (e) {
        console.error('Failed to save to storage', e);
    }
}

export function AppProvider({ children }) {
    const saved = loadFromStorage();
    // Merge saved state with initialState to handle schema migrations
    const mergedState = saved ? { ...initialState, ...saved, toasts: [] } : initialState;
    const [state, dispatch] = useReducer(reducer, mergedState);

    const enhancedDispatch = useCallback((action) => {
        dispatch(action);
        // We need to save after dispatch but we don't have the new state in this closure.
        // We'll use a workaround: save in a timeout
        setTimeout(() => {
            const el = document.getElementById('__app_state');
            if (el) {
                try {
                    saveToStorage(JSON.parse(el.dataset.state));
                } catch (e) { }
            }
        }, 0);
    }, []);

    // Save state on every render via a hidden element
    if (typeof window !== 'undefined') {
        setTimeout(() => {
            const el = document.getElementById('__app_state');
            if (el) {
                el.dataset.state = JSON.stringify(state);
                saveToStorage(state);
            }
        }, 0);
    }

    return (
        <AppContext.Provider value={{ state, dispatch: enhancedDispatch }}>
            <div id="__app_state" style={{ display: 'none' }} />
            {children}
        </AppContext.Provider>
    );
}

export function useApp() {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error('useApp must be used within AppProvider');
    return ctx;
}
