'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  hub-balance.js — последний ИЗВЕСТНЫЙ баланс пулов для шапки хаба.
//
//  Читается с диска (routing/*-sessions.json), а не по HTTP у дашборда: цифра
//  нужна и когда дашборд лежит — как раз тогда её больше нигде и не увидеть.
//  Это кэш, который дашборд обновляет сам при опросе, поэтому число «последнее
//  известное», а не живое; хаб так его и подписывает.
//
//  🪤 Мёртвый ключ с остатком — не деньги. Такой же предикат стоит в сортировке
//  таблиц дашборда (ARCHITECTURE.md § «Таблица аккаунтов шлюза»): деньги на
//  отозванном ключе недоступны, и складывать их в «доступно» значит врать.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const ROUTING = path.join(__dirname, '..', 'routing');

// Живые денежные шлюзы. XPeach в списке нет намеренно — он легаси (см. память
// проекта: «живых денежных шлюзов четыре»), и его остатки в сумму не идут.
const POOLS = [
    { id: 'ar', file: 'agentrouter-sessions.json', name: 'AgentRouter' },
    { id: 'go', file: 'gorouter-sessions.json', name: 'GoRouter' },
    { id: 'jw', file: 'justwoker-sessions.json', name: 'JustWoker' },
    { id: 'tb', file: 'tabi-sessions.json', name: 'Tabi Token' },
];

function readPool(p) {
    let rows = [];
    try {
        const doc = JSON.parse(fs.readFileSync(path.join(ROUTING, p.file), 'utf8'));
        rows = Array.isArray(doc) ? doc : (doc.accounts || doc.sessions || Object.values(doc).find(Array.isArray) || []);
    } catch {
        return { ...p, keys: 0, live: 0, available: 0, checkedAt: 0 };
    }

    let live = 0, available = 0, checkedAt = 0;
    for (const r of rows) {
        const dead = String(r.status || '').toLowerCase() === 'dead';
        const bal = Number(r.balance);
        if (!dead) live++;
        // В сумму идут только живые ключи с ОПРОШЕННОЙ цифрой: `balance` без
        // `balanceCheckedAt` — это не ноль, а «мы не знаем».
        if (!dead && Number.isFinite(bal) && r.balanceCheckedAt) available += Math.max(0, bal);
        const t = Date.parse(r.balanceCheckedAt || 0);
        if (Number.isFinite(t) && t > checkedAt) checkedAt = t;
    }
    return { ...p, keys: rows.length, live, available, checkedAt };
}

function balance() {
    const pools = POOLS.map(readPool);
    return {
        pools,
        keys: pools.reduce((s, p) => s + p.keys, 0),
        live: pools.reduce((s, p) => s + p.live, 0),
        available: pools.reduce((s, p) => s + p.available, 0),
        checkedAt: Math.max(0, ...pools.map(p => p.checkedAt)),
    };
}

module.exports = { balance, POOLS };
