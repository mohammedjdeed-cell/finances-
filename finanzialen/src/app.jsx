    const { useState, useEffect, useMemo, useRef, createContext, useContext } = React;

    const firebaseConfig = {
      apiKey: "AIzaSyCvKICFZCwQz5e70HTLDA_eDD4Us8XqNas",
      authDomain: "finances-ed83f.firebaseapp.com",
      projectId: "finances-ed83f",
      storageBucket: "finances-ed83f.firebasestorage.app",
      messagingSenderId: "707569388994",
      appId: "1:707569388994:web:f23232e15d439df1ba5a5b"
    };

    let db = null;
    let auth = null;
    try {
      firebase.initializeApp(firebaseConfig);
      db = firebase.firestore();
      // settings() must run before any other Firestore call.
      db.settings({ ignoreUndefinedProperties: true, merge: true });
      // Firestore's own offline cache queues writes made offline and replays them later.
      db.enablePersistence({ synchronizeTabs: true }).catch(e => console.warn('Firestore offline cache unavailable:', e.code));
      auth = firebase.auth();
    } catch (e) {
      console.warn("Firebase unavailable, running local-only.", e);
    }
    const safeStorage = {
      get: (k, fb) => { try { return localStorage.getItem(k) || fb; } catch(e) { return fb; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch(e) {} }
    };

    // Households: each one is its own Firestore document. Who may open which is decided only by
    // the Firestore rules (no email addresses in this file); the app shows the ones you can open.
    const HOUSEHOLD_IDS = ['house_finanzen_state', 'household_2', 'household_3'];
    let activeHousehold = (() => { const v = safeStorage.get('budget_household', HOUSEHOLD_IDS[0]); return HOUSEHOLD_IDS.includes(v) ? v : HOUSEHOLD_IDS[0]; })();
    const stateDocRef = () => db.collection('monthly_logs').doc(activeHousehold);
    // Device cache per household (the first keeps its old key).
    const cacheKey = (base) => activeHousehold === HOUSEHOLD_IDS[0] ? base : `${base}:${activeHousehold}`;

    const YEARS = [2026, 2027, 2028];
    const TYPES = ['incomes', 'expenses'];
    const ALL_MONTHS = ["Jan", "Feb", "Mrz", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
    const getMonthsForYear = (yr) => yr === 2026 ? ["Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"] : ALL_MONTHS;
    const TIMELINE = YEARS.flatMap(yr => getMonthsForYear(yr).map(m => ({ yr, m })));
    const timelineIndex = (yr, m) => TIMELINE.findIndex(x => x.yr === yr && x.m === m);
    const timelineKey = (yr, m) => `${yr}|${m}`;
    const round2 = (n) => Math.round(n * 100) / 100;
    const pad2 = (n) => String(n).padStart(2, '0');
    const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
    // "2026-10-14" → { yr: 2026, m: 'Okt' }, or null outside the app's months.
    const dateToMonth = (iso) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
      if (!match) return null;
      const yr = +match[1], m = ALL_MONTHS[+match[2] - 1];
      return m && TIMELINE.some(x => x.yr === yr && x.m === m) ? { yr, m } : null;
    };
    const WHO = ['me', 'partner', 'joint'];

    // ---- Bank statements (Revolut CSV/Excel in English or German, and similar German bank exports) ----
    const parseCsv = (text) => {
      text = text.replace(/^﻿/, '');
      const first = text.split(/\r?\n/)[0] || '';
      const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
      const rows = [];
      let row = [], field = '', quoted = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
          if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
          else field += c;
        } else if (c === '"') quoted = true;
        else if (c === sep) { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
          if (c === '\r' && text[i + 1] === '\n') i++;
          row.push(field); rows.push(row); row = []; field = '';
        } else field += c;
      }
      if (field || row.length) { row.push(field); rows.push(row); }
      return rows.filter(r => r.some(x => String(x).trim()));
    };
    const parseBankNumber = (v) => {
      if (typeof v === 'number') return v;
      let str = String(v ?? '').trim().replace(/\s|€|EUR/g, '');
      if (!str) return null;
      if (str.includes(',') && str.includes('.')) {
        str = str.lastIndexOf(',') > str.lastIndexOf('.') ? str.replace(/\./g, '').replace(',', '.') : str.replace(/,/g, '');
      } else if (str.includes(',')) str = str.replace(',', '.');
      const n = parseFloat(str);
      return isFinite(n) ? n : null;
    };
    const parseBankDate = (v) => {
      if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
      const str = String(v || '').trim();
      let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/.exec(str);
      if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
      // "Aug 5, 2026" (Revolut statements), "5 Aug 2026", "5. Aug. 2026"
      const mon = (w) => { const k = w.toLowerCase().slice(0, 3).replace('mä', 'mar').replace('mrz', 'mar').replace('okt', 'oct').replace('dez', 'dec').replace('mai', 'may');
        const i = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(k); return i === -1 ? null : i + 1; };
      m = /^([A-Za-zäÄ]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(str);
      if (m && mon(m[1])) return `${m[3]}-${pad2(mon(m[1]))}-${pad2(m[2])}`;
      m = /^(\d{1,2})\.?\s+([A-Za-zäÄ]{3,})\.?\s+(\d{4})/.exec(str);
      if (m && mon(m[2])) return `${m[3]}-${pad2(mon(m[2]))}-${pad2(m[1])}`;
      return null;
    };
    // A statement can hold several tables (Revolut's consolidated statement: one per account, each
    // under a title like "Joint Account (EUR)"). Every row that looks like a table header starts one.
    const readStatement = (rows) => {
      if (!rows.length) return null;
      const isHeader = (r) => { const h = (r || []).map(x => String(x ?? '').trim().toLowerCase());
        return h.some(x => /date|datum|buchungstag/.test(x)) && h.some(x => /^amount$|^betrag|money in\/out/.test(x)) && h.some(x => /description|beschreibung|empfänger|begünstigter|beguenstigter|verwendungszweck|payee/.test(x)); };
      const starts = rows.map((r, i) => isHeader(r) ? i : -1).filter(i => i !== -1);
      if (!starts.length) return null;
      const out = [];
      starts.forEach((s0, k) => {
        // The section title: the nearest non-empty single-cell row above the header (skipping "Transaction statement").
        let section = '';
        for (let j = s0 - 1; j >= 0 && j >= s0 - 6; j--) { const cells = rows[j].map(x => String(x ?? '').trim()).filter(Boolean);
          if (cells.length === 1 && !/transaction statement|^-+$/i.test(cells[0])) { section = cells[0]; break; } }
        const part = readStatementTable(rows.slice(s0, starts[k + 1] ?? rows.length));
        const cur = /\((usd|gbp|chf|try|pln)\)/i.exec(section);
        (part || []).forEach(x => out.push({ ...x, section, currency: cur ? cur[1].toUpperCase() : x.currency }));
      });
      return out;
    };
    const readStatementTable = (rows) => {
      if (!rows.length) return null;
      const header = rows[0].map(h => String(h).trim().toLowerCase());
      const find = (...patterns) => {
        for (const re of patterns) { const i = header.findIndex(h => re.test(h)); if (i !== -1) return i; }
        return -1;
      };
      const col = {
        date: find(/completed date|abschluss|abgeschlossen/, /started date|startdatum|^datum$|^date$|buchungstag|buchungsdatum/),
        // Pending lines have no completion date yet; fall back to when they started.
        started: find(/started date|startdatum/),
        desc: find(/^description$|beschreibung|empfänger|beguenstigter|begünstigter|zahlungspflichtiger|payee/, /verwendungszweck|reference/),
        amount: find(/^amount$|^betrag|money in\/out/),
        fee: find(/^fee$|gebühr/),
        currency: find(/currency|währung/),
        state: find(/^state$|^status$|^zustand$/),
        kind: find(/^type$|^art$|^typ$|umsatzart|^category$/),
        // Wise: the shop's own name is clearer than "Card transaction of … issued by …".
        merchant: find(/^merchant$/)
      };
      if (col.date === -1 || col.desc === -1 || col.amount === -1) return null;
      return rows.slice(1).map(r => ({
        date: parseBankDate(r[col.date]) || (col.started !== -1 ? parseBankDate(r[col.started]) : null),
        desc: (col.merchant !== -1 && String(r[col.merchant] || '').trim()) || String(r[col.desc] || '').trim(),
        amount: parseBankNumber(r[col.amount]),
        fee: col.fee !== -1 ? (parseBankNumber(r[col.fee]) || 0) : 0,
        currency: col.currency !== -1 ? String(r[col.currency] || '').trim().toUpperCase() : 'EUR',
        state: col.state !== -1 ? String(r[col.state] || '').trim().toUpperCase() : '',
        kind: col.kind !== -1 ? String(r[col.kind] || '').trim().toUpperCase() : ''
      })).filter(x => x.date && x.amount !== null && x.desc && !/^total$/i.test(x.desc));
    };
    // ---- PDF statements (Sparkasse, Volksbank and similar German banks) ----
    // Lines like "17.08.2026 elektr. Überweisung   -79,00" start a booking; the indented lines under it
    // name who was paid. Balance lines ("Kontostand …") and fee notes without an amount are skipped.
    const readPdfStatement = (lines) => {
      const out = [];
      let cur = null;
      const amountRe = /(-?\s?[\d.]+,\d{2})\s*([+-])?$/;
      lines.forEach(raw => {
        const line = raw.replace(/\s+/g, ' ').trim();
        if (!line) return;
        const m = /^(\d{2}\.\d{2}\.\d{2,4})\s+(.*)$/.exec(line);
        if (m && amountRe.test(m[2])) {
          const am = amountRe.exec(m[2]);
          let amount = parseBankNumber(am[1].replace(/\s/g, ''));
          if (am[2] === '-') amount = -Math.abs(amount);
          const text = m[2].slice(0, am.index).replace(/\s*\/\s*Wert:.*$/i, '').trim();
          cur = { date: parseBankDate(m[1]), text, amount, extra: [] };
          out.push(cur);
          return;
        }
        if (/^(kontostand|der kontostand|anzahl anlagen|seite \d|kontoauszug|girokonto|datum\s|übertrag)/i.test(line)) { cur = null; return; }
        if (cur && cur.extra.length < 2 && !/siehe anlage/i.test(line)) cur.extra.push(line);
      });
      return out.filter(x => x.date && x.amount).map(x => {
        const who = (x.extra[0] || '').replace(/\bDATUM\b.*$/i, '').replace(/\s\d{6,}.*$/, '').trim();
        return { date: x.date, desc: [who, x.text].filter(Boolean).join(' · ').slice(0, 120) || x.text, amount: x.amount, fee: 0, currency: 'EUR', state: '',
          kind: '' };
      });
    };
    const pdfToLines = async (buf) => {
      const lib = window.pdfjsLib;
      lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const doc = await lib.getDocument({ data: buf }).promise;
      const lines = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        const rowsByY = new Map();
        tc.items.forEach(it => { if (!it.str) return; const y = Math.round(it.transform[5] / 2); const x = it.transform[4];
          if (!rowsByY.has(y)) rowsByY.set(y, []); rowsByY.get(y).push([x, it.str]); });
        [...rowsByY.entries()].sort((a, b) => b[0] - a[0]).forEach(([, parts]) => lines.push(parts.sort((a, b) => a[0] - b[0]).map(p2 => p2[1]).join(' ')));
      }
      return lines;
    };
    // ---- Change history ----
    // Every edit is compared with the state before it; changed amounts are written to data.log.
    const LOG_MAX = 800;
    const diffForLog = (prev, next) => {
      const out = [];
      const txIds = (st) => new Map((st?.tx || []).map(x => [x.id, x]));
      const before = txIds(prev), after = txIds(next);
      const touched = new Set();
      after.forEach((x, id) => { if (!before.has(id)) { out.push({ k: 'tx+', ty: x.type, c: x.cat, d: x.date, a: x.amount, w: x.who }); touched.add(`${x.type}|${x.cat}|${x.date.slice(0, 7)}`); } });
      before.forEach((x, id) => {
        const y = after.get(id);
        if (!y) { out.push({ k: 'tx-', ty: x.type, c: x.cat, d: x.date, a: x.amount, w: x.who }); touched.add(`${x.type}|${x.cat}|${x.date.slice(0, 7)}`); }
        else if (y.amount !== x.amount || y.date !== x.date || y.cat !== x.cat) {
          out.push({ k: 'tx~', ty: y.type, c: y.cat, d: y.date, o: x.amount, n: y.amount });
          touched.add(`${x.type}|${x.cat}|${x.date.slice(0, 7)}`); touched.add(`${y.type}|${y.cat}|${y.date.slice(0, 7)}`);
        }
      });
      Object.keys(next.values || {}).forEach(yr => ['incomes', 'expenses'].forEach(type => {
        const nb = next.values[yr][type] || {}, pb = prev?.values?.[yr]?.[type] || {};
        Object.keys(nb).forEach(cat => Object.keys(nb[cat] || {}).forEach(m => {
          const n = nb[cat][m], o = pb[cat]?.[m];
          ['budget', 'actual'].forEach(f => {
            const nv = n?.[f] || 0, ov = o?.[f] || 0;
            if (nv === ov) return;
            // A receipt already explains the change of what was spent.
            if (f === 'actual' && touched.has(`${type}|${cat}|${yr}-${pad2(ALL_MONTHS.indexOf(m) + 1)}`)) return;
            out.push({ k: f === 'budget' ? 'plan' : 'done', ty: type, c: cat, p: `${yr}|${m}`, o: ov, n: nv });
          });
        }));
      }));
      if ((prev?.startingCapital || 0) !== (next.startingCapital || 0) || prev?.startingMonth !== next.startingMonth) {
        out.push({ k: 'start', p: next.startingMonth, o: prev?.startingCapital || 0, n: next.startingCapital || 0 });
      }
      return out;
    };

    // Money Manager (Android) export: Date, Account, Category, Subcategory, Note, EUR, Income/Expense, …
    const isMoneyManagerSheet = (rows) => {
      const header = (rows[0] || []).map(h => String(h).trim().toLowerCase());
      return header.includes('income/expense') && header.includes('category');
    };
    const readMoneyManager = (rows) => {
      const header = rows[0].map(h => String(h).trim().toLowerCase());
      const at = (name) => header.indexOf(name);
      const col = { date: at('date'), account: at('account'), cat: at('category'), sub: at('subcategory'),
        note: at('note'), eur: at('eur'), kind: at('income/expense'), currency: at('currency') };
      if (col.date === -1 || col.cat === -1 || col.kind === -1 || col.eur === -1) return null;
      const txt = (r, i) => i === -1 ? '' : String(r[i] ?? '').trim();
      // Categories start with an emoji ("🪑 Household"); drop it, it can also come out garbled.
      const plain = (v) => { const m = /^(\S{1,3})\s+(.+)$/.exec(v); return m && !/[A-Za-z0-9\u0600-\u06FF]/.test(m[1]) ? m[2].trim() : v; };
      return rows.slice(1).map(r => {
        const kind = txt(r, col.kind);
        const eur = Math.abs(parseBankNumber(r[col.eur]) ?? NaN);
        const account = txt(r, col.account), cat = plain(txt(r, col.cat)), sub = plain(txt(r, col.sub)), note = txt(r, col.note);
        const isTransfer = /^transfer/i.test(kind);
        return {
          date: parseBankDate(r[col.date]),
          desc: isTransfer ? `${account} → ${cat}` : [cat, sub, note].filter(Boolean).join(' · '),
          amount: /^income$/i.test(kind) ? eur : -eur,
          fee: 0, currency: 'EUR', state: '',
          kind: isTransfer ? 'TRANSFER' : '',
          mm: { account, cat, sub, note, kind: kind.toLowerCase() },
          // Learn by category, not by the free-text note.
          ruleKey: `mm:${cat}|${sub}`.toLowerCase()
        };
      }).filter(x => x.date && isFinite(x.amount) && x.amount !== 0 && /^(income|expense|transfer)/i.test(x.mm.kind));
    };
    // Money Manager category → app group, plus which item names in that group fit best.
    const MM_HINTS = [
      [/rent|miete/i, 'housing', /miete|rent/i],
      [/electric|strom/i, 'bills', /strom|electric/i],
      [/^gas$|heiz/i, 'bills', /gas|heiz/i],
      [/water|wasser|swk/i, 'bills', /wasser|water/i],
      [/^net\b|communication|handy|phone|internet/i, 'bills', /internet|handy|o2|vodafone|kabel|phone/i],
      [/rundfunk|radio|ard/i, 'bills', /rundfunk|radio/i],
      [/subscription|abo/i, 'subs', null],
      [/insurance|versicherung/i, 'insurance', null],
      [/grocer|lebensmittel/i, 'groceries', /lebensmittel|grocer|einkauf/i],
      [/^dm$|drogerie|beauty|kosmetik/i, 'groceries', /drogerie|dm|beauty/i],
      [/health|gesundheit|apotheke/i, 'groceries', /gesund|health|apotheke|drogerie/i],
      [/food|restaurant|essen/i, 'leisure', /essen|restaurant|food|lieferung/i],
      [/gift|geschenk/i, 'leisure', /geschenk|gift/i],
      [/transport|ticket|bahn/i, 'household', /transport|ticket|bahn|deutschland/i],
      [/household|haushalt|hausrat/i, 'household', /hausrat|haushalt|household/i],
      [/apparel|kleidung|cloth/i, 'household', /kleidung|cloth|apparel/i],
      [/electronic|amazon|امازون/i, 'household', /elektronik|electronic|amazon/i],
      [/education|bildung|legal|papers/i, 'household', /bildung|education|papier|amt|legal/i]
    ];
    const payeeKey = (desc) => desc.toLowerCase().replace(/[0-9*#\/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    const cleanItemName = (name) => name.toLowerCase().replace(/[^a-z0-9äöüß &-]/g, '').replace(/\s+/g, ' ').trim();
    // Which built-in group a payee most likely belongs to.
    const PAYEE_HINTS = [
      [/netto|edeka|lidl|aldi(?! talk)|rewe|kaufland|penny|norma|globus|türk|turk|bäcker|backer|bakery|\bdm\b|dm-drogerie|rossmann|müller|apotheke|pharmacy|arzt|praxis/i, 'groceries'],
      [/netflix|spotify|prime video|amazon prime|google|youtube|apple\.com|icloud|claude|anthropic|openai|chatgpt|disney/i, 'subs'],
      [/\bo2\b|telefonica|vodafone|telekom|congstar|aldi talk|strom|stadtwerke|vattenfall|e\.on|\beon\b|rundfunk|beitragsservice/i, 'bills'],
      [/miete|vermieter|hausverwaltung/i, 'housing'],
      [/versicherung|insurance|care concept|haftpflicht|allianz|huk/i, 'insurance'],
      [/restaurant|café|cafe|mcdonald|burger|pizza|döner|doner|lieferando|uber eats|wolt|kino|cinema/i, 'leisure'],
      [/ikea|action|tedi|kik|primark|h&m|zara|amazon|amzn|bahn|bvg|mvg|hvv|rmv|flixbus|tankstelle|aral|shell|esso/i, 'household']
    ];
    const prettyPayee = (desc) => desc.replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ').slice(0, 30);

    const MONTH_NAMES = {
      de: { Jan: "Jan", Feb: "Feb", Mrz: "Mär", Apr: "Apr", Mai: "Mai", Jun: "Jun", Jul: "Jul", Aug: "Aug", Sep: "Sep", Okt: "Okt", Nov: "Nov", Dez: "Dez" },
      en: { Jan: "Jan", Feb: "Feb", Mrz: "Mar", Apr: "Apr", Mai: "May", Jun: "Jun", Jul: "Jul", Aug: "Aug", Sep: "Sep", Okt: "Oct", Nov: "Nov", Dez: "Dec" },
      // Levantine month names, as used at home.
      ar: { Jan: "كانون الثاني", Feb: "شباط", Mrz: "آذار", Apr: "نيسان", Mai: "أيار", Jun: "حزيران", Jul: "تموز", Aug: "آب", Sep: "أيلول", Okt: "تشرين الأول", Nov: "تشرين الثاني", Dez: "كانون الأول" }
    };

    const formatMonth = (mKey, lang) => MONTH_NAMES[lang]?.[mKey] || MONTH_NAMES['en']?.[mKey] || mKey;

    const getCurrentInitialDate = () => {
      const now = new Date();
      const currentMonthKey = ALL_MONTHS[now.getMonth()];
      const targetYear = YEARS.includes(now.getFullYear()) ? now.getFullYear() : YEARS[0];
      const validMonths = getMonthsForYear(targetYear);
      const targetMonth = validMonths.includes(currentMonthKey) ? currentMonthKey : validMonths[0];
      return { year: targetYear, month: targetMonth };
    };

    const getDaysInMonth = (year, monthStr) => {
      const mIdx = ALL_MONTHS.indexOf(monthStr);
      return new Date(year, (mIdx === -1 ? 5 : mIdx) + 1, 0).getDate();
    };

    const monthStatus = (yr, m) => {
      const now = new Date();
      const a = yr * 12 + ALL_MONTHS.indexOf(m);
      const b = now.getFullYear() * 12 + now.getMonth();
      return a < b ? 'past' : a === b ? 'current' : 'future';
    };

    // The three rules behind every expected number in the app:
    //   income            → the received amount if entered, otherwise the plan
    //   fixed / one-time  → the paid amount if entered, otherwise the plan
    //   variable group    → the group's target, or what was spent if that's already more;
    //                       once the month is over, only what was actually spent
    const expectedIncome = (node) => node.actual > 0 ? node.actual : node.budget;
    const knownAmount = (node) => node.actual > 0 ? node.actual : node.budget;
    const variableExpected = (spent, target, yr, m) =>
      monthStatus(yr, m) === 'past' ? spent : Math.max(spent, target);

    // Expense groups. Every expense item belongs to one group and behaves like it:
    // fixed and one-time items have a planned amount you tick off as paid; variable
    // items collect receipts, and their group carries one monthly target.
    const GROUP_KINDS = ['fixed', 'variable', 'oneoff'];
    const GROUP_HEX = {
      blue: '#2383e2', teal: '#0f7b6c', purple: '#8a5cb5', brown: '#9f6b53',
      amber: '#cb912f', orange: '#d9730d', pink: '#c14c8a', indigo: '#5b5bd6', gray: '#787774'
    };
    const GROUP_COLORS = Object.keys(GROUP_HEX);
    const DEFAULT_GROUPS = [
      { id: 'housing', kind: 'fixed', color: 'blue', name: null },
      { id: 'bills', kind: 'fixed', color: 'teal', name: null },
      { id: 'subs', kind: 'fixed', color: 'purple', name: null },
      { id: 'insurance', kind: 'fixed', color: 'brown', name: null },
      { id: 'groceries', kind: 'variable', color: 'amber', name: null },
      { id: 'household', kind: 'variable', color: 'orange', name: null },
      { id: 'clothing', kind: 'variable', color: 'indigo', name: null },
      { id: 'leisure', kind: 'variable', color: 'pink', name: null },
      { id: 'oneoff', kind: 'oneoff', color: 'gray', name: null }
    ];
    // An item's mode follows its group's kind. It is one-time when its group is a
    // one-time group or when the item itself was created as a single payment ("once").
    const metaForGroup = (groups, groupId, payDay = null, once = false, forNext = false) => {
      const g = groups.find(x => x.id === groupId) || groups[0];
      const oneTime = g.kind === 'oneoff' || !!once;
      return {
        bracket: g.id,
        mode: g.kind === 'variable' ? 'variable' : 'fixed',
        oneTime,
        once: !!once,
        payDay,
        // Paid at month-end from the salary that just arrived, so it belongs to the next month.
        // Only for items with a known amount; receipts in variable groups stay where they happen.
        forNext: !!forNext && (g.kind !== 'variable' || oneTime)
      };
    };

    // One-tap suggestions shown inside the built-in variable groups.
    const STORE_SUGGESTIONS = {
      groceries: ['Netto', 'Edeka', 'Lidl', 'Aldi', 'Rewe', 'Kaufland', 'Türkischer Markt', 'DM', 'Rossmann', 'Apotheke'],
      household: ['IKEA', 'Action', 'Amazon', 'TEDi'],
      clothing: ['Primark', 'H&M', 'C&A', 'Zara', 'Deichmann', 'KiK', 'Takko'],
      leisure: ['Restaurant', 'Café', 'Kino', 'Geschenke']
    };
    const REPEAT_OPTIONS = [1, 2, 3, 6, 12];

    // Where an item from before groups existed belongs, judged by its name and old settings.
    const legacyGroupFor = (cat, meta) => {
      const p = cat.toLowerCase();
      const has = (...keys) => keys.some(k => p.includes(k));
      if (meta.oneTime) return 'oneoff';
      if (has('netflix', 'spotify', 'prime', 'abo', 'subscription', 'youtube', 'disney', 'apple', 'amazon', 'google', 'claude', 'icloud', 'chatgpt')) return 'subs';
      if (meta.mode === 'fixed') {
        if (has('miete', 'rent', 'wohn', 'nebenkosten')) return 'housing';
        if (has('versicherung', 'insurance', 'care concept', 'schule', 'school', 'kurs')) return 'insurance';
        if (has('strom', 'gas', 'heiz', 'wasser', 'internet', 'wlan', 'handy', 'o2', 'vodafone', 'telekom', 'rundfunk', 'mobil', 'telefon', 'ticket', 'transport', 'bank')) return 'bills';
        if (meta.bracket === 'housing') return 'housing';
        if (meta.bracket === 'professional') return 'insurance';
        return 'bills';
      }
      if (has('versicherung', 'insurance', 'care concept', 'schule', 'school')) return 'insurance';
      if (has('restaurant', 'cafe', 'café', 'unterhaltung', 'freizeit', 'leisure', 'geschenk', 'gift', 'kino')) return 'leisure';
      if (has('hausrat', 'haushalt', 'household', 'möbel', 'kleidung', 'clothes', 'ikea', 'transport', 'ticket', 'tank')) return 'household';
      if (has('lebensmittel', 'food', 'grocer', 'supermarkt', 'netto', 'edeka', 'rewe', 'lidl', 'aldi', 'dm', 'rossmann', 'bäcker', 'gesundheit', 'health', 'apotheke', 'arzt', 'drogerie')) return 'groceries';
      if (has('prüfung', 'exam', 'b2', 'fsp')) return 'oneoff';
      if (meta.bracket === 'leisure') return 'leisure';
      if (meta.bracket === 'living') return 'groceries';
      return 'household';
    };

    const BRACKET_PALETTES = {
      housing: { tag: 'bg-notion-tagBlue text-blue-600 dark:text-blue-400' },
      subscriptions: { tag: 'bg-notion-tagPurple text-purple-600 dark:text-purple-400' },
      living: { tag: 'bg-notion-tagAmber text-amber-700 dark:text-amber-400' },
      professional: { tag: 'bg-notion-tagGreen text-teal-700 dark:text-teal-400' },
      leisure: { tag: 'bg-pink-500/10 text-pink-600 dark:text-pink-400' },
      other: { tag: 'bg-notion-tagGray text-stone-600 dark:text-stone-300' },
      fixed_in: { tag: 'bg-notion-tagGreen text-emerald-700 dark:text-emerald-400' },
      variable_in: { tag: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400' },
      g_fixed: { tag: 'bg-notion-tagBlue text-blue-600 dark:text-blue-400' },
      g_flex: { tag: 'bg-notion-tagAmber text-amber-700 dark:text-amber-400' }
    };

    const getPalette = (bracketId) => BRACKET_PALETTES[bracketId] || BRACKET_PALETTES.other;

    const DEFAULT_BRACKETS = {
      expenses: [
        { id: 'housing', color: '#2383e2', icon: 'fa-house' },
        { id: 'subscriptions', color: '#6940a5', icon: 'fa-ticket' },
        { id: 'living', color: '#dfab01', icon: 'fa-basket-shopping' },
        { id: 'professional', color: '#0f7b6c', icon: 'fa-graduation-cap' },
        { id: 'leisure', color: '#e03e3e', icon: 'fa-champagne-glasses' },
        { id: 'other', color: '#787774', icon: 'fa-box-archive' }
      ],
      incomes: [
        { id: 'fixed_in', color: '#0f7b6c', icon: 'fa-building-columns' },
        { id: 'variable_in', color: '#2383e2', icon: 'fa-coins' }
      ]
    };

    const INITIAL_CATEGORIES = {
      incomes: ["Mohammed Sperrkonto", "Mai Sperrkonto", "Side Income", "Darlehen Schwester (Eingang)", "Sonstiges"],
      expenses: [
        "Miete", "Kaution", "Lebensmittel 🍞", "Hausrat 🛋️", "Strom ⚡", "Gas & Heizung",
        "Unterhaltung 🎊", "Restaurant & Cafe 🍔", "Geschenke", "Gesundheit ❤️",
        "B2 Prüfung", "Versicherung Care Concept", "Kleidung", "Rundfunkbeitrag", "Internet & Handy",
        "Transport & Tickets", "Bankgebühren", "Swan Schule", "FSP Prüfung",
        "Möbel Vormieter", "Rückzahlung Schwester", "Sonstiges"
      ]
    };

    // A new household starts with neutral items and names, ready to be renamed.
    const FRESH_CATEGORIES = {
      incomes: ["Gehalt", "Sonstiges"],
      expenses: ["Miete", "Strom ⚡", "Internet & Handy", "Rundfunkbeitrag", "Lebensmittel 🍞", "Hausrat 🛋️",
        "Restaurant & Cafe 🍔", "Transport & Tickets", "Kleidung", "Geschenke", "Sonstiges"]
    };
    // Names a household starts with (they can be changed in Settings).
    const HOUSEHOLD_PRESETS = {
      household_2: { name: "Miea's Household", members: { me: 'Sawsan', partner: 'Rabee' } }
    };
    const freshHousehold = () => normalizeState({
      categories: FRESH_CATEGORIES,
      members: HOUSEHOLD_PRESETS[activeHousehold]?.members || { me: 'Ich', partner: 'Partner' },
      name: HOUSEHOLD_PRESETS[activeHousehold]?.name || ''
    });

    const DEFAULT_ONE_TIME = {
      "Kaution": true,
      "FSP Prüfung": true,
      "Möbel Vormieter": true,
      "Rückzahlung Schwester": true,
      "Darlehen Schwester (Eingang)": true
    };

    // Names the "merge into fallback" delete can target, in any language.
    const FALLBACK_NAMES = ["Sonstiges", "Other"];

    const autoClassifyCategory = (name) => {
      const p = name.toLowerCase();
      if (["netflix", "spotify", "prime", "abo", "subscription", "youtube", "disney", "apple", "amazon"].some(k => p.includes(k))) return { bracket: 'subscriptions', mode: 'fixed', isOneTime: false };
      if (["miete", "rent", "kaution", "deposit", "strom", "gas", "heizung", "radio", "rundfunk", "internet", "wlan", "handy", "furniture", "möbel"].some(k => p.includes(k))) return { bracket: 'housing', mode: 'fixed', isOneTime: p.includes("kaution") || p.includes("deposit") || p.includes("furniture") || p.includes("möbel") };
      if (["essen", "food", "lebensmittel", "restaurant", "cafe", "supermarkt", "bäcker", "rewe", "lidl", "aldi", "dm", "rossmann", "kleidung", "ticket", "transport"].some(k => p.includes(k))) return { bracket: 'living', mode: 'variable', isOneTime: false };
      if (["exam", "prüfung", "schule", "school", "b2", "fsp", "swan", "kurs", "versicherung", "insurance", "care concept", "arzt", "health", "gesundheit"].some(k => p.includes(k))) return { bracket: 'professional', mode: 'variable', isOneTime: p.includes("exam") || p.includes("prüfung") || p.includes("anmeldung") || p.includes("kaution") };
      if (["unterhaltung", "geschenke", "freizeit", "leisure"].some(k => p.includes(k))) return { bracket: 'leisure', mode: 'variable', isOneTime: false };
      return { bracket: 'other', mode: 'fixed', isOneTime: p.includes("rückzahlung") || p.includes("darlehen") || p.includes("repayment") || p.includes("loan") };
    };

    const translations = {
      de: {
        title: "Jdeeds' Household",
        subtitle: "Persönlicher Cashflow & Budget",
        startingCapital: "Startguthaben (Konto & Bar)",
        startingMonthLabel: "Stand zu Beginn von",
        startingHint: "Echter Bestand zu Beginn des ersten Monats, ab dem alle Einnahmen und Ausgaben erfasst sind. Monate davor zählen nicht zum Endbestand.",
        beforeStart: "Vor dem Startmonat",
        backCalcNote: "Rückgerechnet vom echten Kontostand im {{month}}",
        kpiActualNet: "Ist-Saldo (Monatsgewinn)",
        kpiActualNetDesc: "Tippen für genaue Aufstellung",
        kpiProjectedNet: "Prognose Saldo",
        kpiDailyRoom: "Freies Tagesbudget",
        kpiCumulative: "Endbestand",
        kpiCumulativeSub: "Zum Monatsende",
        kpiDailyRoomSub: "Verfügbares Tagesbudget",
        endOfMonthTitle: "Erwarteter Stand Ende {{month}}",
        endOfMonthTitlePast: "Stand Ende {{month}}",
        carriedOver: "Übertrag aus {{month}}",
        carriedStart: "Startguthaben",
        lineIncome: "Einnahmen",
        lineFixed: "Fixkosten",
        lineFlex: "Variabel & einmalig",
        receivedOf: "{{done}} von {{total}} erhalten",
        paidOf: "{{done}} von {{total}} bezahlt",
        paidCount: "{{n}} von {{m}} Posten bezahlt",
        spentOf: "{{done}} ausgegeben · Ziel {{total}}",
        targetLeft: "Noch {{amount}} bis zum Ziel",
        targetOver: "{{amount}} über dem Ziel",
        stillOpen: "Noch offen: {{amount}}",
        stillExpected: "Noch erwartet: {{amount}}",
        expectedRules: "So wird gerechnet: Einnahmen = erhalten, sonst geplant · Fixkosten & Einmaliges = bezahlt, sonst geplant · Variable Gruppen = Monatsziel, oder mehr wenn schon überschritten. Abgelaufene Monate: nur was wirklich rein- und rausging.",
        thisMonth: "Dieser Monat",
        breakdownBtn: "Alle Beträge",
        fixBalanceBtn: "Mit echtem Kontostand korrigieren",
        fixBalanceTitle: "Echten Kontostand eintragen",
        fixBalanceTodayLabel: "Kontostand heute (Konto + Bar)",
        fixBalanceStartLabel: "Kontostand zu Beginn von {{month}} (Konto + Bar)",
        fixBalanceTodayDesc: "Aus diesem Betrag und den in {{month}} schon eingetragenen Beträgen (erhalten {{in}}, ausgegeben {{out}}) wird der Übertrag berechnet. Trag also zuerst alles ein, was diesen Monat schon passiert ist. Ältere Monate zählen danach nicht mehr mit.",
        fixBalanceStartDesc: "Ab {{month}} wird mit diesem Betrag gerechnet. Ältere Monate zählen danach nicht mehr mit.",
        fixBalancePreview: "Übertrag wird: {{amount}}",
        fixBalanceSave: "Übernehmen",
        groups: {
          transport: "Mobilität",
          health: "Gesundheit & Sport",
          education: "Bildung & Prüfungen",
          fees: "Bank & Gebühren",
          family: "Familie & Freunde",
          kids: "Kinder",
          housing: "Wohnen",
          bills: "Rechnungen & Kommunikation",
          subs: "Abos",
          insurance: "Versicherungen",
          groceries: "Lebensmittel & Drogerie",
          household: "Haushalt",
          clothing: "Kleidung & Schuhe",
          leisure: "Freizeit & Essen gehen",
          oneoff: "Einmalig"
        },
        filterAll: "Alle",
        filterFixed: "Fix",
        filterVariable: "Variabel & einmalig",
        moreTab: "Übersicht",
        groupLabel: "Gruppe",
        groupPaidSub: "{{n}} von {{m}} bezahlt · {{amount}} offen",
        groupAllPaid: "Alles bezahlt",
        groupNothingPlanned: "Nichts geplant",
        groupTargetSub: "von {{target}} · noch {{left}}",
        groupOverSub: "{{amount}} über dem Ziel von {{target}}",
        groupNoTarget: "Noch kein Monatsziel",
        monthlyTarget: "Monatsziel",
        monthlyTargetHint: "Gilt ab {{month}} für alle folgenden Monate",
        itemsCount: "{{n}} Posten",
        dueOn: "Fällig am {{day}}.",
        notPaidYet: "Noch nicht bezahlt",
        receivedLabel: "Erhalten",
        expectedLabel: "Erwartet",
        receiptsCount: "{{n}} Belege",
        receiptsOne: "1 Beleg",
        nothingYet: "Noch nichts",
        addReceipt: "Beleg",
        addReceiptTo: "Beleg zu {{name}} hinzufügen",
        addBtn: "Hinzufügen",
        receiptAdded: "{{amount}} zu {{name}} hinzugefügt · {{group}}: {{spent}} von {{target}}",
        receiptAddedNoTarget: "{{amount}} zu {{name}} hinzugefügt · {{group}}: {{spent}}",
        receiptSheetTitle: "Beleg hinzufügen",
        receiptWhere: "Wo hast du es ausgegeben?",
        receiptNeedAmount: "Gib zuerst einen Betrag ein und wähle dann den Laden.",
        receiptNoItems: "Lege zuerst in einer variablen Gruppe einen Posten an, z. B. Netto.",
        spentTotalLabel: "Ausgegeben im {{month}} (gesamt)",
        tapCircleHint: "Kreis antippen, wenn bezahlt",
        tapPlusHint: "+ antippen für einen Beleg",
        addItemShort: "+ Posten",
        newGroup: "+ Neue Gruppe",
        groupDialogNew: "Neue Gruppe",
        groupDialogEdit: "Gruppe bearbeiten",
        groupNameLabel: "Name",
        groupNamePlaceholder: "z. B. Auto, Haustier, Sparen",
        groupKindLabel: "Art",
        groupColorLabel: "Farbe",
        groupKindHelp_fixed: "Bekannte Beträge, die du als bezahlt abhakst: Miete, Abos, Rechnungen.",
        groupKindHelp_variable: "Belege sammeln, ein Monatsziel für die ganze Gruppe: Lebensmittel, Drogerie.",
        groupKindHelp_oneoff: "Einzelne Zahlungen in einem bestimmten Monat: Prüfung, Kaution.",
        groupDelete: "Gruppe löschen",
        groupDeleteMove: "Ihre {{n}} Posten verschieben nach:",
        groupSave: "Speichern",
        actPeriod: "Zeitraum",
        actEdit: "Bearbeiten",
        markReceivedAria: "{{name}} als erhalten markieren",
        markPaidAria: "{{name}} als bezahlt markieren",
        groupFixed: "Fixkosten · Miete, Rechnungen, Abos",
        groupFlex: "Variabel & einmalig",
        targetLabel: "Ziel",
        spentLabel: "Ausgegeben",
        paidLabel: "Bezahlt",
        markPaid: "Bezahlt",
        markReceived: "Erhalten",
        markPaidHint: "Geplanten Betrag als bezahlt eintragen",
        markReceivedHint: "Geplanten Betrag als erhalten eintragen",
        kpiIn: "Ein",
        kpiOut: "Aus",
        kpiProjPrefix: "Prognose:",
        incomesHeader: "Einnahmen",
        expensesHeader: "Ausgaben",
        analyticsTab: "Übersicht & IOU",
        planLabel: "Plan",
        actualLabel: "Ist",
        asOfDayLabel: "Tag",
        asOfDayHint: "Stand: Tag im Monat. Leer = automatisch (heute).",
        restBudgetLabel: "Verbleibend",
        perDayLabel: "/ Tag",
        statusOver: "Über Budget",
        statusTrack: "Im Rahmen",
        statusFrugal: "Sparsam",
        badgeOneTime: "Einmalig",
        badgeFixed: "Fix",
        badgeVariable: "Variabel",
        modeLabel: "Art",
        options: "Einstellungen",
        themeLabel: "Erscheinungsbild",
        themeLight: "Hell",
        themeDark: "Dunkel",
        themeSystem: "System",
        cloudSync: "Cloud-Sync",
        signIn: "Mit Google anmelden",
        signOut: "Abmelden",
        signedInAs: "Angemeldet als {{email}}",
        signInError: "Anmeldung fehlgeschlagen: {{msg}}",
        syncLocalOnly: "Nur auf diesem Gerät gespeichert. Anmelden, um zwischen Geräten zu synchronisieren.",
        syncStatus_local: "Nur lokal",
        syncStatus_pending: "Speichert…",
        syncStatus_synced: "Synchronisiert",
        syncStatus_error: "Sync-Fehler – Daten sind lokal gesichert",
        backupSection: "Daten & Sicherung",
        exportBackup: "JSON Exportieren",
        importBackup: "JSON Wiederherstellen",
        importSuccess: "Daten erfolgreich importiert!",
        importError: "Fehlerhafte Datei.",
        clearAll: "Alle Daten löschen",
        confirmClear: "Möchten Sie wirklich alle Daten unwiderruflich löschen?",
        showAllBtn: "0 € sichtbar (Alle zeigen)",
        hideZeroesBtn: "0 € ausgeblendet",
        showZeroTitle: "0 € Posten einblenden",
        hideZeroTitle: "0 € Posten ausblenden",
        hiddenNoticeBracket: "{{count}} inaktive Posten (0 €) ausgeblendet",
        showNow: "Einblenden",
        expandAll: "Alle aufklappen",
        collapseAll: "Alle schließen",
        annualOverview: "Jahresübersicht",
        annualRunway: "Runway & Jahresverlauf",
        annualSavingsRate: "Sparquote (Prognose)",
        annualMonth: "Monat",
        annualNet: "Ist-Saldo",
        annualProjected: "Prognose",
        annualBalance: "Endbestand",
        annualTotal: "Summe",
        iouTitle: "Verbindlichkeiten & Forderungen (Darlehen / IOU)",
        iouAddBtn: "Eintragen",
        iouPersonPlaceholder: "Z. B. Schwester (900€ Leihe)...",
        iouAmountPlaceholder: "Betrag",
        iouOptBorrowed: "Ich schulde (Leihe/Kredit)",
        iouOptLent: "Mir wird geschuldet (Verliehen)",
        iouDebts: "Schulden:",
        iouReceivables: "Forderung:",
        iouSisterTip: "Geld von Schwester geliehen (900 €)?",
        iouSisterHint: "Bucht +{{amount}} als Einnahme in {{month}} und plant zwei Rückzahlungen à {{half}} in {{m1}} & {{m2}}.",
        iouSisterBtn: "⚡ Darlehen erhalten & Rückzahlung planen",
        iouIOweBadge: "Schulde ich",
        iouOwedToMeBadge: "Bekomme ich",
        iouMarkReturned: "Als erledigt markieren",
        iouLoanLink: "Darlehen erhalten & Rückzahlungen planen",
        iouDelete: "Löschen (falsch eingetragen)",
        iouDeleteConfirm: "„{{person}} · {{amount}}“ löschen? Das entfernt nur diesen Eintrag aus der Schulden-Liste, nicht die Einnahme oder die Rückzahlungen.",
        loanDuplicateWarn: "Du hast schon ein Darlehen über {{amount}} eingetragen ({{person}}, {{date}}). Nochmal buchen zählt Einnahme, Rückzahlungen und Schuld doppelt.",
        emptyGroupIncomes: "Keine aktiven Buchungen in diesem Monat.",
        emptyGroupExpenses: "Keine Ausgaben in dieser Gruppe für diesen Monat.",
        editorTitle: "Eigenschaft bearbeiten",
        posten: "Bezeichnung",
        bracketLabel: "Kategorie",
        paymentDayShort: "Zahltag",
        deleteCategoryBtn: "Löschen",
        saveClose: "Schließen & Sichern",
        addItemBtn: "+ Neuer Eintrag",
        notesTitleMonth: "Notizen & Belege ({{month}} {{year}})",
        addNotePlaceholder: "Notiz oder Beleg hinzufügen...",
        quickAddModalTitle: "Neuen Posten anlegen",
        quickAddNamePlaceholder: "Z. B. Rückzahlung Schwester, Netflix...",
        initialBudgetLabel: "Geplanter Betrag (€)",
        isOneTimeCurrentOnly: "Nur im Monat „Von“ (in allen anderen Monaten 0 €)",
        rangeFrom: "Von",
        rangeUntil: "Bis",
        rangeSummary: "{{n}} Monate: {{from}} – {{until}}",
        rangeSummaryOne: "1 Monat: {{from}}",
        repeatLabel: "Wiederholen",
        repeat1: "Jeden Monat",
        repeat2: "Alle 2 Monate",
        repeat3: "Alle 3 Monate (vierteljährlich)",
        repeat6: "Alle 6 Monate (halbjährlich)",
        repeat12: "Einmal im Jahr",
        paymentsSummary: "{{n}} Zahlungen: {{list}}",
        quickStores: "Schnell hinzufügen:",
        importTitle: "Kontoauszug importieren",
        importBtn: "⬇ Import",
        importAccount: "Von welchem Konto?",
        importOwn: "Konto {{name}}",
        importJoint: "Gemeinsames Konto",
        importFrom: "Nur Buchungen ab",
        importFromHint: "Monate, die du schon von Hand eingetragen hast, würden sonst doppelt zählen.",
        importChoose: "Datei auswählen (CSV, Excel oder PDF)",
        importHowTo: "Revolut: Konto öffnen → „…“ → Kontoauszug → CSV oder Excel (auch der „konsolidierte“ Auszug mit allen Konten). Wise: Konto → Kontoauszüge → CSV. Sparkasse, Volksbank & Co.: den PDF-Kontoauszug aus dem Online-Banking oder die CSV-Umsätze. Money Manager (Excel) geht auch.",
        importBadFile: "Diese Datei konnte nicht gelesen werden. Erwartet wird ein Kontoauszug (CSV, Excel oder PDF) mit Datum, Beschreibung und Betrag.",
        importSummary: "{{file}}: {{n}} Zeilen · {{ready}} zugeordnet · {{dup}} schon importiert · {{skipped}} übersprungen",
        importSelectAll: "Alle mit Vorschlag auswählen",
        importSelectNone: "Keine auswählen",
        importSkipOption: "— nicht importieren —",
        importNewItem: "Neu: {{name}}",
        importNothingNew: "Keine neuen Buchungen in dieser Datei.",
        importSkippedList: "{{n}} übersprungene Zeilen anzeigen",
        importSkip_dup: "schon importiert",
        importSkip_state: "nicht abgeschlossen",
        importSkip_currency: "andere Währung",
        importSkip_range: "außerhalb Mai 2026 – Dez 2028",
        importSkip_before: "vor dem gewählten Datum",
        importSkip_exchange: "Währungstausch",
        importSkip_future: "liegt in der Zukunft (bleibt geplant)",
        importSkip_entered: "schon von Hand eingetragen (gleicher Tag und Betrag)",
        importTotals: "Ausgewählt: + {{inSum}} rein · − {{outSum}} raus · netto {{net}}",
        importThenBalance: "jetzt „Mit echtem Kontostand korrigieren“",
        importRun: "{{n}} Buchungen importieren",
        importDone: "{{n}} Buchungen importiert",
        importOwnTransfer: "Eigene Umbuchung",
        importReplacesTick: "ersetzt dein Häkchen",
        importTransfersNote: "{{n}} Umbuchungen zwischen euren eigenen Konten erkannt. Sie sind weder Einnahme noch Ausgabe und bleiben deshalb abgewählt.",
        dueTitle: "Fällig bald",
        dueOverdue: "Überfällig seit {{day}}. {{month}}",
        dueOnDay: "Fällig am {{day}}. {{month}}",
        dueInMonth: "Im {{month}}",
        dueMore: "+ {{n}} weitere anzeigen",
        dueLess: "Weniger anzeigen",
        dueThis: "Dieser Monat",
        dueNext: "Nächster",
        dueBoth: "Beide",
        dueNothing: "Alles bezahlt 🎉",
        dueNoDay: "Ohne festen Tag",
        forecastTitle: "Ausblick: Stand am Monatsende (12 Monate)",
        incomeEndTitle: "Einnahmen, die enden",
        incomeEndLast: "Letzte Zahlung: {{when}}",
        incomeEndFrom: "fehlt ab {{month}}",
        incomeEndTotal: "Ab {{month}} fehlen zusammen {{amount}} pro Monat.",
        incomeEndHint: "Plant rechtzeitig, wie ihr das ersetzt: mit einem Puffer, niedrigeren Ausgaben oder neuem Einkommen. Die rote Linie im Ausblick zeigt, ab wann es fehlt.",
        forecastLow: "Tiefster Stand: {{amount}} Ende {{month}}",
        forecastNegative: "Achtung: Ende {{month}} wärst du bei {{amount}}",
        setAsideTitle: "Zurücklegen",
        setAsideHint: "Unregelmäßige und kommende einmalige Zahlungen, auf den Monat verteilt. Wer das jeden Monat zur Seite legt, wird davon nicht überrascht.",
        setAsideRhythm: "{{n}}× in 12 Monaten · nächste {{month}}",
        setAsideOnce: "einmalig im {{month}}",
        perMonthShort: "{{amount}}/Monat",
        goalsTitle: "Sparziele",
        goalNew: "+ Ziel",
        goalNewTitle: "Neues Sparziel",
        goalEdit: "Sparziel bearbeiten",
        goalsEmpty: "Noch keine Sparziele, z. B. Notgroschen, Handy oder Urlaub.",
        goalNamePlaceholder: "z. B. Notgroschen",
        goalTarget: "Zielbetrag",
        goalSaved: "Schon gespart",
        goalDeadline: "Bis wann?",
        goalNoDeadline: "Ohne Termin",
        goalHint: "Sparziele zählen nicht in die Monatsrechnung. Hier verfolgst du nur, wie viel schon beiseitegelegt ist.",
        goalReached: "Ziel erreicht 🎉",
        goalPerMonth: "{{amount}}/Monat bis {{month}}",
        goalLeft: "Noch {{amount}}",
        goalDeposit: "+ Einzahlen",
        goalDeposited: "{{amount}} für „{{name}}“ gespart",
        goalDeleteConfirm: "Sparziel „{{name}}“ löschen?",
        iouRepaid: "{{repaid}} von {{total}} zurückgezahlt (über „{{item}}“)",
        iouLinkRepay: "Rückzahlungen verknüpfen mit …",
        reportGroups: "Ausgaben nach Gruppe {{year}}",
        reportAvgNote: "Durchschnitt über {{n}} Monate mit Ausgaben.",
        reportTopItems: "Größte Posten",
        reportWhoNote: "Aus einzelnen Einträgen (Belege und Importe).",
        membersLabel: "Haushalt (Namen)",
        autoBackups: "Automatische Sicherungen (dieses Gerät)",
        autoBackupsEmpty: "Noch keine. Ab der nächsten Änderung wird täglich eine Sicherung angelegt.",
        autoBackupsHint: "Eine Sicherung pro Tag, die letzten 14 Tage. Wiederherstellen lässt sich rückgängig machen.",
        autoBackupRestore: "Wiederherstellen",
        autoBackupConfirm: "Stand vom {{day}} wiederherstellen? Alles danach wird ersetzt.",
        autoBackupRestored: "Sicherung wiederhergestellt",
        beforePaydayTitle: "Bleibt bis zum nächsten Gehalt · {{month}}",
        beforePaydayLine: "Vor dem nächsten Gehalt",
        carriedBeforeSalary: "Rest vor dem Gehalt aus {{month}}",
        linePaidEndPrev: "Ende {{month}} bezahlt (für diesen Monat)",
        leavingForNext: "Geht Ende {{month}} für {{next}} ab",
        forNextExpLabel: "Vom nächsten Gehalt bezahlt",
        forNextExpHelp: "Wird erst nach dem Gehalt am Monatsende bezahlt (z. B. Miete am 28.) und zählt deshalb zum Folgemonat. Trag es im Monat ein, in dem es bezahlt wird.",
        lineIncomeFromPrev: "Gehalt aus {{month}} (für diesen Monat)",
        lineIncomeThis: "Weitere Einnahmen im {{month}}",
        arrivingForNext: "Kommt Ende {{month}} für {{next}}",
        availableNow: "Jetzt auf den Konten (laut Einträgen)",
        forNextBadge: "→ für {{month}}",
        forNextLabel: "Für den nächsten Monat",
        forNextHelp: "Kommt am Monatsende (z. B. am 26.) und wird im Folgemonat ausgegeben. Trag es im Monat ein, in dem es ankommt; gezählt wird es im nächsten.",
        shiftTip: "Kommt euer Gehalt erst Ende des Monats? Öffne es bei den Einnahmen → ✎ Bearbeiten → „Für den nächsten Monat“. Dann zeigt diese Zahl, was bis zum nächsten Gehalt wirklich bleibt.",
        paydayLabel: "Gehalt kommt am",
        paydayOff: "Kein fester Tag (Kalendermonat)",
        paydayOption: "{{day}}. (Budgetmonat: {{day}}. bis {{until}}.)",
        paydayHelp: "Euer Budgetmonat beginnt mit dem Gehalt. Rechnungen mit Zahltag ab diesem Tag und Belege ab diesem Datum zählen automatisch zum nächsten Monat, auch für das Monatsziel.",
        forNextAuto: "Zählt automatisch zum Folgemonat (Zahltag {{day}}. ≥ Gehaltstag {{payday}}.)",
        countsForNext: "Zählt für {{month}}",
        whoJoint: "Gemeinsam",
        whoLabel: "Wer hat bezahlt?",
        whoPaidTitle: "Wer hat bezahlt? (Ausgaben)",
        noteLabel: "Notiz (optional)",
        dateLabel: "Datum",
        undoBtn: "Rückgängig",
        txDeleted: "{{amount}} bei {{name}} gelöscht",
        entriesLabel: "Einträge ({{n}})",
        txBtn: "Buchungen",
        navOverview: "Übersicht",
        navMonth: "Monat",
        navActivity: "Aktivität",
        navPlan: "Planung",
        navMore: "Mehr",
        prevMonth: "Vorheriger Monat",
        nextMonth: "Nächster Monat",
        todayBtn: "Heute",
        dismiss: "Ausblenden",
        heroIn: "Rein",
        heroOut: "Raus",
        heroStart: "Start",
        heroDetails: "Rechnung zeigen",
        heroHide: "Rechnung ausblenden",
        howCalc: "Wie wird gerechnet?",
        quickReceipt: "Beleg",
        quickImport: "Import",
        quickAsk: "Fragen",
        quickHistory: "Verlauf",
        incomeEndShort: "{{n}} Einnahmen enden · ab {{month}} fehlen {{amount}}",
        showDetails: "Details",
        hideDetails: "Weniger",
        emptyItems: "{{n}} ohne Betrag",
        hideEmpty: "Leere ausblenden",
        emptyGroups: "Ohne Beträge in diesem Monat ({{n}})",
        actEntries: "Belege",
        actHistory: "Verlauf",
        actSummary: "Monatsabschluss",
        planYear: "Jahr",
        planOutlook: "Ausblick",
        accountsTitle: "Konten",
        accountsIntro: "Trag ab und zu die echten Kontostände ein – die App vergleicht sie mit ihren Zahlen.",
        accountsSetup: "Unsere Konten anlegen",
        accountAdd: "+ Konto",
        accountMain: "Hauptkonten",
        accountGateway: "Durchgangskonten",
        accountCash: "Bargeld",
        accountsTotal: "Gesamt",
        accountsAppNow: "Laut App jetzt",
        accountsDiff: "Unterschied",
        accountsUse: "Als echten Kontostand übernehmen",
        accountsUsed: "Kontostand übernommen: {{amount}}",
        accountsUpdated: "geprüft {{day}}",
        accountName: "Name",
        accountsMatch: "Passt ✓",
        accountRemoved: "Konto entfernt",
        entrySaved: "Eintrag gespeichert",
        entryTitle: "Eintrag bearbeiten",
        itemFromBank: "Bank",
        itemGroupOf: "{{group}}: {{spent}} von {{target}}",
        itemOfPlan: "von {{plan}} geplant",
        itemNoPlan: "Kein Plan für diesen Monat",
        itemAdd: "Eintragen",
        itemPaid: "Bezahlt",
        itemReceived: "Erhalten",
        itemMarkPaid: "Als bezahlt",
        itemMarkReceived: "Als erhalten",
        itemSettings: "Einstellungen",
        itemEntries: "Einträge in diesem Monat ({{n}})",
        itemNoEntries: "Noch nichts eingetragen.",
        edPlanCard: "Plan & Wiederholung",
        stillIn: "Kommt bis Monatsende noch rein",
        stillOut: "Geht bis Monatsende noch raus",
        accountSavings: "Sparkonten",
        savingsOutItem: "Ersparnisse",
        savingsInItem: "Aus Ersparnissen",
        savingsHint: "Geld auf Sparkonten zählt nicht als ausgebbar. Überweise mit „Hinzufügen → Überweisung“ dorthin oder zurück.",
        fixTitle: "{{n}} Einträge von dir stehen auch in diesem Auszug",
        fixHint: "Wer bezahlt hat und welches Konto, so wie es im Auszug steht. Häkchen entfernen, was so bleiben soll.",
        fixBtn: "{{n}} Einträge korrigieren",
        fixDone: "{{n}} Einträge korrigiert",
        labsTitle: "Neue Funktionen (einzeln abschaltbar)",
        labsNowToday: "„Jetzt“ ohne Einträge nach heute",
        labsReminders: "Erinnerungen an fällige Rechnungen",
        labsImportAmount: "Import erkennt Rechnungen am Betrag",
        labsCloseMonth: "Monatsabschluss-Karte",
        labsSplitUp: "Wer hat was bezahlt",
        srchTitle: "Suchen",
        srchPh: "Laden, Posten, Notiz oder Betrag – z. B. Action",
        srchAll: "Alle Jahre",
        srchFound: "{{n}} Einträge",
        srchHint: "Mindestens 2 Zeichen eingeben.",
        cmTitle: "{{month}} abschließen",
        cmSub: "noch {{n}} Tage",
        cmStepAccounts: "Kontostände eintragen (damit „Jetzt“ stimmt).",
        cmOpenAccounts: "Konten öffnen",
        cmStepBillsOpen: "{{n}} Rechnungen noch offen ({{amount}}).",
        cmStepBillsDone: "Alle Rechnungen bezahlt.",
        cmStepLeftover: "Übrig in den Einkaufs-Budgets: {{amount}}",
        cmToGoal: "{{amount}} ins Sparziel",
        cmNoGoal: "Lege unter „Planung“ ein Sparziel an, um den Rest dorthin zu legen.",
        suTitle: "Wer hat was bezahlt",
        suEven: "Ihr habt diesen Monat etwa gleich viel bezahlt.",
        suOwes: "{{who}} gibt {{to}} {{amount}}, dann seid ihr quitt.",
        suHint: "Nur Einträge mit „Wer?“ – gemeinsame Ausgaben zählen nicht mit.",
        remTitle: "Erinnerungen ({{n}})",
        remAllow: "Handy-Benachrichtigung an",
        rem_overdue: "überfällig",
        rem_today: "heute fällig",
        rem_tomorrow: "morgen fällig",
        rem_late: "noch nicht eingegangen",
        acctSince: "Seit {{day}}: {{n}} Einträge, {{delta}}",
        acctExpected: "→ {{amount}} übernehmen",
        futureNote: "Gebucht für nach heute – noch nicht auf dem Konto",
        loanDupSpare: "doppelt – diese Kopie kann weg",
        loanSettledList: "Erledigte Darlehen ({{n}})",
        loanPaidVia: "zurückgezahlt über „{{item}}“: {{amount}}",
        loanNoLink: "ohne Rückzahlungs-Posten",
        loanDup: "doppelt?",
        loanReopen: "Wieder öffnen",
        loanSettledToast: "Darlehen erledigt – offene geplante Rückzahlungen entfernt",
        pmToggle: "Jeden Monat anders",
        pmDefault: "Betrag für Monate ohne eigenen Wert (€)",
        pmList: "{{n}} Monate · zusammen {{total}}",
        pmUsePaid: "Bezahlte Beträge übernehmen ({{n}})",
        pmHint: "Jeden Monat einzeln ändern. ✓ = in diesem Monat schon bezahlt.",
        kWhatKind: "Was ist es?",
        kPurchase: "Einkauf",
        kBill: "Rechnung (monatlich)",
        kSub: "Abo",
        kOnebill: "Einmalige Rechnung",
        kOneoffIn: "Einmalig",
        kRegularIn: "Regelmäßig",
        kEvery: "Alle",
        kMonth1: "Monat",
        kMonthsN: "{{n}} Monate",
        kOnDay: "fällig am",
        kOnDayIn: "kommt am",
        kDueOn: "Fällig am {{date}} (Datum unten ändern)",
        kPaidNow: "Schon bezahlt (jetzt eintragen)",
        kReceivedNow: "Schon erhalten (jetzt eintragen)",
        kHintRepeatPaid: "Wird ab diesem Monat alle {{every}} geplant und diese Zahlung eingetragen.",
        kHintRepeatLater: "Wird nur geplant – erscheint unter „Bald fällig“, bis du es abhakst.",
        kHintOnebillPaid: "Einmal geplant und gleich als bezahlt eingetragen.",
        kHintOnebillLater: "Einmal geplant – erscheint unter „Bald fällig“ und im Kalender.",
        kBillCard: "{{month}}: {{plan}} geplant",
        kDueDay: "fällig am {{d}}.",
        kAlreadyPaid: "Schon bezahlt ({{amount}}) – nochmal eintragen zählt doppelt.",
        kPartPaid: "Bisher {{amount}} bezahlt.",
        bkPlanned: "„{{name}}“ geplant – noch nichts bezahlt.",
        selStart: "Auswählen",
        selDone: "Fertig",
        selMonth: "Dieser Monat ({{n}})",
        selAllMonths: "Alle Monate ({{n}})",
        selNotPlan: "Alle außer {{amount}} ({{n}})",
        selNone: "Keine",
        moveTo: "Verschieben nach … (Posten wählen oder neu tippen)",
        moveBtn: "{{n}} verschieben",
        moveNew: "Neuer Posten „{{name}}“ wird angelegt.",
        movedToast: "{{n}} Einträge → {{to}}",
        entryItemSettings: "Posten bearbeiten",
        entryCreate: "„{{name}}“ anlegen",
        entryMoveAll: "Auch die {{n}} anderen Einträge über {{amount}} aus „{{from}}“ verschieben (z. B. frühere Monate)",
        motionLabel: "Animationen",
        motionOn: "An",
        motionOff: "Aus",
        shopAllItems: "Alle Posten …",
        shopNewItem: "Neuer Posten",
        shopWhat: "Was hast du bei {{shop}} gekauft?",
        shopKeep: "Oder nichts antippen – dann bleibt es bei „{{shop}}“.",
        shopBoughtAt: "Bei {{shop}} gekauft → {{item}}",
        splitBtn: "Auf mehrere Posten aufteilen",
        splitTitle: "Aufteilen",
        splitCancel: "Nicht aufteilen",
        splitRest: "Rest",
        splitAdd: "Weiterer Posten",
        splitTooMuch: "Die Teile sind zusammen so hoch wie der Betrag oder höher – für den ersten Posten bleibt nichts.",
        logoSearch: "Logo suchen – z. B. DB, Rewe, Vodafone",
        logoNone: "Kein Logo gefunden – nimm unten ein Symbol.",
        mergedToast: "„{{from}}“ ist jetzt Teil von „{{to}}“",
        dcSame: "„{{a}}“ und „{{b}}“ sehen nach demselben aus.",
        dcMergeInto: "In „{{name}}“ zusammenführen",
        mergeLabel: "Zusammenführen mit",
        mergePick: "Posten wählen …",
        mergeConfirm: "Alle Einträge, Pläne und Notizen von „{{from}}“ nach „{{to}}“ verschieben und „{{from}}“ entfernen?",
        schNow: "Aktuell:",
        schFrom: "ab {{month}}",
        schFirst: "erste Zahlung {{amount}}",
        schEveryMonth: "dann {{amount}} jeden Monat",
        schEveryN: "dann {{amount}} alle {{n}} Monate",
        schOpenEnd: "ohne Ende",
        schUntil: "bis {{month}}",
        schOdd: "{{n}} Monat(e) mit anderem Betrag – bleiben, solange du hier nichts änderst.",
        schFirstToggle: "Erste Zahlung ist anders",
        schFirstLabel: "Erste Zahlung (€)",
        schThenLabel: "Danach jeweils (€)",
        calNothingDay: "Keine Zahlungen an diesem Tag",
        otAdd: "Über „Buchen“ eintragen",
        calKind_earlier: "Früher eingetragen",
        calKind_loan: "Darlehen",
        calLegShops: "Läden & Gruppen",
        calLegTap: "Doppeltipp = Tagesansicht",
        tipsTitle: "KI-Vorschläge",
        tipsSub: "Persönliche Tipps zu diesem Monat",
        tipsFrom: "Stand {{when}}",
        tipsGet: "Vorschläge holen",
        tipsRefresh: "Neu",
        tipsIntro: "Die KI schaut sich euren aktuellen Monat an (Ziele, Rechnungen, Kontostand, Sparquote) und gibt 3–5 kurze, konkrete Tipps. Nur auf Knopfdruck – jede Abfrage kostet ein paar Cent API-Guthaben.",
        tipsOtherLang: "Diese Tipps sind in einer anderen Sprache – „Neu“ holt sie in der aktuellen.",
        calModeMonth: "Monat",
        calModeDay: "Tag",
        calLegGroups: "Farbe = Gruppe",
        edTabDetails: "Angaben",
        edTabPeriod: "Beträge & Zeitraum",
        actEditAll: "Bearbeiten",
        starterBtn: "Startpaket Familie",
        starterDone: "Startpaket hinzugefügt: Einnahmen, Rechnungen, Kinder und Läden",
        starterHint: "Fügt typische Einnahmen (2× Sperrkonto, Kindergeld), Rechnungen, Kinder-Posten und Läden hinzu – nur was noch fehlt.",
        rcPhoto: "Bon fotografieren",
        rcHint: "Tipp: 📷 Bon fotografieren – die KI trägt Laden, Betrag und Datum ein.",
        rcBusy: "Bon wird gelesen …",
        rcNone: "Auf dem Foto war kein Betrag zu lesen.",
        rcRead: "Gelesen: {{amount}} · {{shop}} – bitte prüfen und eintragen",
        ovArrange: "Karten anordnen",
        ovArrangeHint: "Reihenfolge der Karten auf der Übersicht ändern oder Karten ausblenden (Auge). Wird auf diesem Gerät gespeichert.",
        ovToggle: "Ein-/ausblenden",
        ovReset: "Zurücksetzen",
        ovDone: "Fertig",
        ovN_review: "Monatsrückblick",
        rvTitle: "Rückblick {{month}}",
        rvSubPlus: "{{amount}} mehr eingenommen als ausgegeben",
        rvSubMinus: "{{amount}} mehr ausgegeben als eingenommen",
        rvDone: "Erledigt",
        rvIn: "Eingenommen",
        rvOut: "Ausgegeben",
        rvNet: "Ergebnis",
        rvPlanned: "geplant",
        rvSurprises: "Mehr als geplant:",
        rvBiggest: "Größte Posten:",
        rvCheckBal: "Kontostände prüfen",
        rvHint: "Ein kurzer Blick am Monatsanfang: Stimmen die Kontostände, startet der neue Monat mit richtigen Zahlen.",
        bkTransfer: "Umbuchung",
        trFrom: "Von Konto",
        trTo: "Auf Konto",
        trMove: "Kontostände anpassen",
        trMoveHint: "Zieht den Betrag beim einen Konto ab und rechnet ihn beim anderen dazu. Zählt nie als Einnahme oder Ausgabe.",
        trNeedAccounts: "Bitte zwei verschiedene Konten wählen.",
        trSaved: "{{amount}} umgebucht: {{from}} → {{to}}",
        trDeleted: "Umbuchung gelöscht",
        calKind_transfer: "Umbuchung",
        dcTitle: "Daten-Check",
        dcSub: "{{n}} Punkte machen die Zahlen ungenauer",
        dcUndated: "{{n}} Rechnungen haben kein Fälligkeitsdatum – tippen, um den Tag einzutragen:",
        dcGap: "Eure Konten zeigen {{real}}, die Einträge {{app}} – {{diff}} Unterschied. Etwas fehlt oder ist doppelt.",
        dcUseReal: "Echten Stand übernehmen",
        dcCheckAccounts: "Konten ansehen",
        dcDupLoan: "„{{person}}“ · {{amount}} ist {{n}}× als Darlehen eingetragen – vielleicht doppelt?",
        dcReview: "Ansehen",
        dcLoanMoney: "{{n}} ältere Darlehen sind noch nicht im Kontostand geprüft.",
        dcNoDate: "{{n}} Einkäufe in diesem Monat haben keinen Tag ({{amount}}) und fehlen deshalb im Kalender. Tippe einen an, wähle den Tag und speichere.",
        dcOpenAdd: "Zu „Buchen“",
        bkRepeat: "Zuletzt – tippen zum Wiederholen",
        bkLeft: "Danach noch {{amount}} übrig",
        bkOver: "Damit {{amount}} über dem Ziel",
        bkNoPlan: "Für diesen Monat ist kein Ziel gesetzt.",
        bkSearchBig: "Laden oder Posten suchen – z. B. Netto, Kita, DHL",
        bkFound: "{{n}} eigene Posten gefunden",
        bkOther: "Andere",
        bkMoreSugg: "+ {{n}} weitere",
        bkSuggest: "Neu anlegen – tippen zum Auswählen:",
        calPaid: "Bezahlt",
        calGot: "Bekommen",
        calStillDue: "Noch fällig",
        calDue: "Fällig",
        calExpected: "Erwartet",
        calKind_receipt: "Bon",
        calKind_bill: "Rechnung",
        calKind_spent: "Ausgabe",
        calKind_income: "Einnahme",
        calLegPaid: "bezahlt",
        calLegDue: "noch fällig",
        calLegIn: "Einnahme",
        calUndated: "Ohne Tag in diesem Monat: {{n}} Posten · {{amount}}",
        calUndatedHint: "Diese Posten haben kein Fälligkeitsdatum. Trage beim Posten den Tag ein (oder buche Einkäufe über „Buchen“), dann erscheinen sie im Kalender.",
        navBook: "Buchen",
        bkOut: "Ausgabe",
        bkIn: "Einnahme",
        bkAmount: "Betrag",
        bkWhere: "Wofür?",
        bkWhereIn: "Woher?",
        bkSearch: "Suchen …",
        bkNew: "Neu",
        bkNewName: "Name, z. B. Rewe",
        bkAll: "Alle {{n}} anzeigen",
        bkLess: "Weniger anzeigen",
        bkWhen: "Wann?",
        bkToday: "Heute",
        bkYesterday: "Gestern",
        bkAccount: "Konto",
        bkNoAccount: "Ohne",
        bkWho: "Wer?",
        bkNote: "Notiz (optional)",
        bkSave: "Eintragen",
        bkSaved: "{{amount}} · {{name}} · {{date}} eingetragen",
        bkNeedAmount: "Bitte einen Betrag eingeben.",
        bkNeedCat: "Bitte wählen, wofür – oder „Neu“ antippen.",
        bkNeedDate: "Dieses Datum liegt außerhalb des Plans.",
        calTitle: "Kalender",
        calTotal: "{{amount}} · {{n}} Einträge",
        calEmpty: "Noch nichts eingetragen in diesem Monat – alles, was du links einträgst, erscheint hier am richtigen Tag.",
        calDayEmpty: "An diesem Tag nichts eingetragen.",
        calAddHere: "+ An diesem Tag eintragen",
        calNote: "Jeder Eintrag zählt beim gewählten Posten im Monat mit (wie ein Bon). Je dunkler ein Tag, desto mehr wurde ausgegeben; ein grüner Punkt heißt Einnahme. Beträge, die direkt im Monat eingetippt wurden, haben kein Datum und erscheinen nicht im Kalender.",
        abRealBal: "Echter Kontostand (Konten, geprüft {{date}})",
        abRealDiff: "Laut Einträgen wären es {{amount}}. Die Konten unter Mehr → Konten aktuell halten, dann stimmt diese Zahl.",
        abNoReal: "Trage unter Mehr → Konten eure echten Kontostände ein – dann rechnet diese Karte vom echten Stand aus.",
        abNowBal: "Stand jetzt (laut Einträgen)",
        abFitsNow: "Für Lebensmittel & Co. sind in diesem Monat noch {{month}} eingeplant; für den {{from}}.–{{to}}. etwa {{amount}} – das passt.",
        abTightNow: "Achtung: Für Lebensmittel & Co. sind noch {{month}} eingeplant; für den {{from}}.–{{to}}. wären das etwa {{amount}} – mehr als verfügbar.",
        abSpendUntil: "Zum Ausgeben bis zum {{day}}. {{month}}",
        abSpendMonth: "Zum Ausgeben in diesem Monat",
        abPerDay: "≈ {{amount}} pro Tag für {{n}} Tage (vom {{from}}. bis {{to}}.)",
        abNothing: "Nach den Rechnungen bleibt bis zum nächsten Geldeingang nichts übrig.",
        abLowest: "Tiefster Stand ({{day}}. {{month}})",
        abLateIn: "Ab dem {{day}}. kommt rein",
        abEnd: "Ende {{month}} (vor Variablem)",
        abFits: "Eure Ziele für Lebensmittel & Co. ({{month}}/Monat) brauchen für den {{from}}.–{{to}}. etwa {{amount}} – das passt.",
        abTight: "Achtung: Eure Ziele für Lebensmittel & Co. brauchen für den {{from}}.–{{to}}. etwa {{amount}} – mehr als verfügbar.",
        abUndated2: "Ohne Datum: {{b}} Rechnungen zählen ab dem 1., {{i}} Einnahmen erst am Monatsende – vorsichtshalber. Trage das Fälligkeitsdatum beim Posten ein.",
        abHint2: "Die Linie ist euer Stand Tag für Tag, nur mit Einnahmen und Rechnungen (ohne Lebensmittel & Co.). Der tiefste Punkt ab heute ist das Geld, das ihr bis zum nächsten Geldeingang für Variables ausgeben könnt, ohne ins Minus zu gehen. Für diesen Monat startet sie beim Stand jetzt (alles schon Eingenommene und Ausgegebene, auch Lebensmittel), für den nächsten beim erwarteten Stand Ende dieses Monats.",
        forecastTitleAll: "Stand am Monatsende: Verlauf & Ausblick",
        forecastNext: "Vorschau",
        forecastAll: "Alle",
        abTitle: "Nach den Rechnungen",
        abThis: "Dieser",
        abNext: "Nächster",
        abOnDay: "Am {{day}}. {{month}} übrig",
        abFree: "Frei nach allen Rechnungen",
        abStart: "Stand am Monatsanfang",
        abIncome: "Einnahmen im Monat",
        abBills: "Rechnungen & feste Kosten",
        abVariable: "Ziele für Variables (Lebensmittel …)",
        abAfterVariable: "Bleibt zum Sparen",
        abLateIncome: "Kommt erst nach dem {{day}}.: {{list}}.",
        abShowList: "Alle {{n}} Rechnungen anzeigen",
        abHideList: "Liste ausblenden",
        abShowList2: "Alle {{n}} Ein- und Ausgänge anzeigen",
        abUndated: "{{n}} Rechnungen ohne Datum sind vorsichtshalber schon bis zum {{day}}. eingerechnet.",
        abHint: "Stand am Monatsanfang = erwarteter Stand Ende des Vormonats. „Am {{day}}.“ = Stand + Einnahmen, die bis dahin kommen − Rechnungen, die bis dahin fällig sind (ohne Datum zählt mit). „Frei“ = Stand + alle Einnahmen − alle Rechnungen und festen Kosten des Monats; davon gehen noch Lebensmittel & Co. ab, der Rest kann gespart werden. Das Fälligkeitsdatum stellst du beim Posten ein.",
        noAccessTitle: "Noch kein Haushalt für dieses Konto",
        noAccessText: "{{email}} ist für keinen Haushalt freigeschaltet. Die angezeigten Namen sind nur Platzhalter. Bitte den Besitzer, diese Adresse in den Firebase-Regeln einzutragen, dann die App neu öffnen.",
        householdLabel: "Haushalt",
        householdUnnamed: "Haushalt ohne Namen",
        householdNew: "Neuen Haushalt anlegen",
        hhWelcome: "Willkommen im neuen Haushalt",
        hhWelcomeText: "Dieser Haushalt ist leer und völlig getrennt von anderen. Gib ihm einen Namen und tragt eure Namen ein – Posten und Gruppen könnt ihr danach im Monat anpassen.",
        hhNamePh: "Name des Haushalts",
        hhMePh: "Dein Name",
        hhPartnerPh: "Name Partner/in",
        hhWelcomeHint: "Startkapital und Startmonat stellst du in den Einstellungen (⚙) ein.",
        hhDone: "Fertig",
        loanMoneyTitle: "Im Kontostand",
        loanCountedIn: "{{amount}} als Einnahme in {{month}} („{{item}}“) gezählt.",
        loanCountedOut: "{{amount}} als Ausgabe in {{month}} („{{item}}“) gezählt.",
        loanCountedEarlier: "Wurde schon früher im Kontostand gezählt.",
        loanUnbook: "Zurücknehmen",
        loanNotCounted: "Nicht im Kontostand – noch nicht {{kind}} gezählt.",
        loanMaybeCounted: "Älteres Darlehen: Ist das Geld schon {{kind}} eingetragen? Wenn nicht, hier in den richtigen Monat buchen.",
        loanAsIncome: "als Einnahme",
        loanAsExpense: "als Ausgabe",
        loanBookInBtn: "Als Einnahme buchen",
        loanBookOutBtn: "Als Ausgabe buchen",
        loanAlreadyCounted: "Ist schon drin",
        loanBookedToast: "Darlehen im Kontostand gebucht",
        loanUnbookedToast: "Buchung zurückgenommen",
        loanListNotCounted: "Nicht im Kontostand – tippen, um es {{kind}} zu buchen",
        loanListCheck: "Im Kontostand? Tippen zum Prüfen und Buchen",
        editStart: "Bearbeiten",
        editDone: "Fertig",
        editOnToast: "Bearbeiten an – Felder können geändert werden",
        editOffToast: "Ansicht – Felder sind gesperrt",
        wgTitle: "Wohin das Geld ging · {{month}}",
        wgSpent: "ausgegeben",
        wgNone: "Für den letzten Monat sind noch keine Ausgaben eingetragen.",
        wgFlow: "Einnahmen und wofür sie gebraucht wurden",
        wg_needs: "Bedürfnisse",
        wg_wants: "Wünsche",
        wg_once: "Einmalig",
        wg_debt: "Schulden getilgt",
        wg_left: "Übrig",
        wgShort: "{{amount}} mehr ausgegeben als eingenommen",
        wgHint: "Der Ring zeigt die Ausgaben des letzten abgeschlossenen Monats nach Gruppen (ohne Sparen und Darlehen). Der Balken teilt die Einnahmen dieses Monats auf: Bedürfnisse, Wünsche, einmalige Ausgaben, getilgte Schulden und was übrig blieb.",
        ycEvery: "alle {{n}} Mon.",
        ycShowAll: "Alle {{n}} anzeigen",
        ycShowLess: "Weniger anzeigen",
        loanRate: "Zinsen pro Jahr in % (optional)",
        healthTitle: "Finanz-Check",
        healthSub: "Rücklage reicht für {{n}} Monate",
        healthSubNone: "Notgroschen, Sparquote, Wünsche & Bedürfnisse",
        healthWhy: "Warum?",
        efTitle: "Notgroschen",
        efMonths: "{{n}} Monate",
        efCore: "Grundkosten {{amount}} / Monat",
        efHave: "Vorhanden",
        ef3: "Ziel 3 Monate",
        ef6: "Ziel 6 Monate",
        efNoAccounts: "Berechnet aus dem App-Kontostand. Trage unter Mehr → Konten eure echten Kontostände ein, dann wird es genauer.",
        efHint: "Grundkosten = was ihr monatlich wirklich braucht (Miete, Rechnungen, Versicherung, Lebensmittel …), Durchschnitt der letzten 3 abgeschlossenen Monate; Gruppen, die als „Wunsch“ markiert sind, und einmalige Posten zählen nicht. Empfehlung: 3 Monate als Minimum, 6 Monate für mehr Sicherheit, am besten auf einem Tagesgeldkonto mit Zinsen.",
        srTitle: "Sparquote",
        srRule: "Zuerst sparen:",
        srOff: "Aus",
        srPayday: "Diesen Monat {{amount}} zur Seite legen ({{pct}} % von {{income}} Einnahmen) – am besten direkt am Zahltag.",
        srDone: "Erledigt ✓",
        srSoFar: "Bisher auf „Ersparnisse“ gebucht: {{amount}}",
        srHint: "Sparquote = (Einnahmen − Ausgaben) ÷ Einnahmen. Darlehen und Umbuchungen auf/von Ersparnissen zählen nicht; Rückzahlungen von Schulden zählen als gespart, weil sie eure Schulden senken. Einen festen Prozentsatz zu sparen heißt: bei jeder Gehaltserhöhung spart ihr automatisch mehr.",
        nwTitle: "Bedürfnisse & Wünsche",
        nwShare: "Anteil Wünsche im {{month}}",
        nwWant: "Wunsch",
        nwNeed: "Bedürfnis",
        nwRising: "Der Anteil der Wünsche steigt seit 3 Monaten.",
        nwHint: "Tippe auf eine Gruppe, um sie als Bedürfnis oder Wunsch zu markieren. Faustregel 50/30/20: etwa die Hälfte für Bedürfnisse, bis 30 % für Wünsche, 20 % sparen. Gebt gern viel für die Dinge aus, die euch wirklich wichtig sind, und spart beim Rest.",
        ycTitle: "Laufende Kosten pro Jahr",
        ycAll: "Alle laufenden Kosten / Jahr",
        ycSubs: "Davon Abos / Jahr",
        ycFees: "Bankgebühren (letzte 12 Monate)",
        ycHint: "Monatliche Beträge sehen klein aus; aufs Jahr gerechnet sieht man, was ein Vertrag wirklich kostet. Einmal im Jahr alle Verträge prüfen und kündigen, was ihr nicht nutzt.",
        dbTitle: "Schulden nach Zinsen",
        dbNone: "Keine offenen Schulden.",
        dbExpensive: "Schulden über 8 % Zinsen zuerst abbezahlen, bevor ihr investiert.",
        dbHint: "Teuerste Schuld zuerst abbezahlen. Zinsen trägst du beim Darlehen ein (✎). Ein Darlehen von der Familie ohne Zinsen ist günstig – keine Eile, aber zuverlässig zurückzahlen.",
        wtTitle: "Nettovermögen",
        wtNow: "Heute (Geld − Schulden + Forderungen)",
        wtHint: "Linie = euer Geld am Monatsende laut App; der grüne Punkt ist heute. Nettovermögen = Geld minus offene Schulden plus Geld, das andere euch schulden. Das Einkommen bezahlt den Alltag, das Vermögen schafft Freiheit.",
        wlTitle: "Wunschliste (72 Stunden)",
        wlSub: "Wünsche erst nach 3 Tagen kaufen",
        wlSaved: "{{amount}} durch Verzicht gespart",
        wlNamePh: "Was möchtest du kaufen?",
        wlAdd: "Wunsch hinzufügen",
        wlEmpty: "Neuer Wunsch über 50 €? Hier eintragen und 3 Tage warten.",
        wlWait: "Noch {{h}} Std. warten",
        wlReady: "Willst du es immer noch?",
        wlSkip: "Verzichten",
        wlBuy: "Kaufen",
        wlSkippedN: "{{n}} Wünsche verworfen · {{amount}} gespart",
        newLoanTitle: "Neues Darlehen",
        loanNewBtn: "Neues Darlehen",
        loanNoneOpen: "Keine offenen Darlehen.",
        loanBorrowed: "Ich habe geliehen",
        loanLent: "Ich habe verliehen",
        loanBorrowerLabel: "An wen?",
        loanPersonPh: "z. B. Schwester, Aram …",
        loanBookIn: "Als Einnahme in {{month}} buchen",
        loanBookOut: "Als Ausgabe in {{month}} buchen",
        loanBookHint: "Ausschalten, wenn das Geld nicht über eure Konten lief.",
        loanInstallments: "Zurückzahlen in Raten",
        loanBackInstallments: "Rückzahlung erwartet in Raten",
        loanNoPlan: "Ohne",
        loanFirstMonth: "Erste Rate",
        loanPreview: "{{n}} × {{amount}} · {{months}}",
        loanSave: "Eintragen",
        loanFromItem: "Darlehen von",
        loanRepayItem: "Rückzahlung an",
        lentToItem: "Verliehen an",
        repaidByItem: "Rückzahlung von",
        loanAdded: "Darlehen eingetragen: {{amount}} · {{person}}",
        loanNeedFields: "Bitte Person, Betrag und Datum angeben.",
        loanShared: "Dieser Rückzahlungsplan gilt für {{n}} Darlehen zusammen ({{amount}}); Zahlungen gehen zuerst an das älteste.",
        loanEditTitle: "Darlehen bearbeiten",
        loanEditExisting: "Stattdessen das bestehende Darlehen bearbeiten",
        loanPerson: "Person",
        loanAmount: "Betrag",
        loanDate: "Datum",
        loanType: "Art",
        loanSchedule: "Rückzahlungsplan",
        loanPlan: "Geplant",
        loanPaid: "Bezahlt",
        loanAddMonth: "+ Monat hinzufügen …",
        loanRemaining: "Noch nicht eingeplant",
        loanPlannedOk: "Alles eingeplant ✓",
        loanPlannedGap: "Die Rückzahlungen ergeben noch nicht den ganzen Betrag. Füg einen Monat hinzu oder ändere einen Betrag.",
        loanNoSchedule: "Noch keine Rückzahlung eingeplant.",
        iconLabel: "Symbol",
        iconAuto: "Automatisch",
        iconAi: "KI-Vorschlag",
        iconsAiTool: "Fehlende Symbole mit KI finden",
        iconsDone: "{{n}} Symbole gesetzt",
        iconsNone: "Keine passenden Symbole gefunden.",
        gestureTip: "Tipp: zur Seite wischen wechselt den Monat · mit zwei Fingern zusammenziehen klappt alle Gruppen zu, auseinanderziehen klappt sie auf.",
        loansTitle: "Leihen & Schulden",
        toolsTitle: "Werkzeuge",
        toolSettings: "Einstellungen & Sicherung",
        toolGroups: "Neue Gruppe",
        toolLang: "Sprache: Deutsch",
        tidyTitle: "Kategorien aufräumen",
        tidyIntro: "Vorschlag: {{n}} Posten in passendere Gruppen verschieben.",
        tidyApply: "Übernehmen",
        tidyDone: "{{n}} Posten neu einsortiert",
        tidyNone: "Alles ist schon gut sortiert.",
        addReceiptShort: "Beleg hinzufügen",
        sectionMonth: "Monat",
        logBtn: "Verlauf",
        askBtn: "Fragen",
        askTitle: "Haushalts-Assistent",
        askIntro: "Frag alles zu euren Zahlen – auf Deutsch, Englisch oder Arabisch. Der Assistent liest eure Einträge, ändert aber nichts.",
        askEx1: "Wie viel haben wir seit September für Lebensmittel ausgegeben?",
        askEx2: "Warum ist der November niedriger als der Oktober?",
        askEx3: "Passt etwas in diesem Monat nicht zusammen?",
        askPlaceholder: "Frage eingeben …",
        askSend: "Senden",
        askNew: "Neues Gespräch",
        askThinking: "Denkt nach …",
        askPrivacy: "Eure Zahlen werden für die Antwort an Claude (Anthropic) gesendet.",
        askNeedSignIn: "Bitte zuerst mit Google anmelden (Einstellungen).",
        askErrSetup: "Der Assistent ist noch nicht eingerichtet (API-Schlüssel in Vercel fehlt oder ist falsch).",
        askErrNotAllowed: "Dieses Google-Konto ist für den Assistenten nicht freigegeben (ALLOWED_EMAILS in Vercel).",
        askErrBusy: "Gerade zu viele Anfragen – bitte gleich nochmal versuchen.",
        askErrRefused: "Darauf kann der Assistent nicht antworten. Bitte anders formulieren.",
        askErrOffline: "Keine Internetverbindung.",
        askErrGeneric: "Das hat nicht geklappt. Bitte nochmal versuchen.",
        logTitle: "Verlauf der Änderungen",
        logAll: "Alle",
        logEmpty: "Noch keine Änderungen gespeichert. Ab jetzt wird jede Änderung hier mit Datum festgehalten.",
        logPlan: "Plan geändert",
        logReceived: "erhalten",
        logPaid: "bezahlt",
        logTxAdd: "Beleg vom {{day}} hinzugefügt",
        logTxDel: "Beleg vom {{day}} gelöscht",
        logTxEdit: "Beleg vom {{day}} geändert",
        logStart: "Startguthaben",
        logBulk: "{{n}} Werte auf einmal geändert (Import oder Wiederherstellung)",
        logNote: "Die letzten {{n}} Änderungen werden mit deinen Daten gespeichert und synchronisiert.",
        viewEnd: "Monatsende",
        viewNow: "Jetzt",
        nowTitle: "Stand jetzt (laut Einträgen)",
        nowReceived: "Schon erhalten",
        nowPaid: "Schon bezahlt & ausgegeben",
        nowStillOpen: "Noch offen bis Monatsende",
        nowRules: "Zählt nur, was abgehakt oder eingetragen ist. Offene Pläne kommen erst in „Ende des Monats“ dazu.",
        txModalTitle: "Buchungen {{month}}",
        txEmpty: "Noch keine einzelnen Einträge. Belege und importierte Kontoauszüge erscheinen hier.",
        rangeMonth: "Monat",
        howOften: "Wie oft?",
        recurringLabel: "Wiederkehrend",
        recurringHelp: "Kommt jeden Monat oder in einem festen Rhythmus wieder.",
        onceHelp: "Nur ein einziges Mal, in einem Monat. Erscheint in keinem anderen Monat.",
        variableItemHelp: "Kein fester Betrag: Belege mit + eintragen. Das Monatsziel gilt für die ganze Gruppe.",
        clearOutside: "Plan außerhalb dieses Zeitraums auf 0 setzen",
        clearOutsideHint: "Entfernt den Plan aus allen anderen Monaten. Tatsächliche Beträge bleiben unverändert.",
        replicateTitle: "Betrag für Zeitraum setzen",
        replicateCatLabel: "Kategorie",
        replicateFieldLabel: "Welcher Wert?",
        replicateBudgetOption: "Plan (Budget)",
        replicateActualOption: "Ist (Ausgegeben)",
        replicateAmountLabel: "Betrag (€)",
        replicateDurationLabel: "Zeitraum",
        duration3: "3 Monate ({{month}} + 2)",
        duration6: "6 Monate ({{month}} + 5)",
        duration12: "12 Monate (1 Jahr)",
        durationAll: "Bis Ende 2028",
        replicateActionBtn: "Übernehmen",
        loanModalTitle: "Darlehen eintragen",
        loanModalDesc: "Trägt das erhaltene Geld sofort als Einnahme ein und plant die Rückzahlungen als Ausgaben in den gewählten Monaten:",
        loanStep1: "1. Geld erhalten (Einnahme für {{month}} {{year}})",
        loanStep2: "2. Rückzahlung planen (Ausgaben)",
        loanReceivedAmountLabel: "Erhaltenes Geld",
        loanLenderLabel: "Wer hat das Geld geliehen?",
        loanIncomeCatLabel: "Bezeichnung Einnahme",
        loanExpenseCatLabel: "Bezeichnung Rückzahlung",
        loanInst1Month: "1. Rate Monat",
        loanInst2Month: "2. Rate Monat",
        loanConfirmBtn: "In Einnahmen & Ausgaben buchen",
        loanSuccessAlert: "Darlehen gebucht! {{inAmount}} als Einnahme in {{inMonth}} verbucht, und {{a1}} in {{m1}} sowie {{a2}} in {{m2}} als Rückzahlung geplant.",
        breakdownTitle: "Aufstellung: Woher kommen die Zahlen für {{month}} {{year}}?",
        breakdownIncomes: "Alle Einnahmen diesen Monat (Summe: {{total}}):",
        breakdownExpenses: "Alle Ausgaben diesen Monat (Summe: {{total}}):",
        breakdownNetResult: "Ergebnis (Ist-Saldo = Einnahmen minus Ausgaben):",
        noItemsInBreakdown: "Keine Beträge eingetragen.",
        closeBtn: "Schließen",
        deleteItemTitle: "Eintrag löschen: {{name}}",
        deleteFutureOnly: "Nur zukünftige Monate leeren",
        deleteFutureOnlyDesc: "Historische Buchungen bleiben erhalten.",
        deletePurgeMerge: "Vollständig löschen & nach '{{fallback}}' verschieben",
        deletePurgeMergeDesc: "Kein Bilanzverlust. Alle Summen und Notizen bleiben erhalten.",
        deleteFallbackBlocked: "„{{name}}“ ist die Auffang-Kategorie und kann nicht in sich selbst verschoben werden.",
        cancelBtn: "Abbrechen",
        duplicateAlert: "Kategorie existiert bereits: \"{{name}}\" ({{bracket}})",
        hideWhenZeroHint: "In Monaten ohne Buchung ausblenden",
        fallbackCategory: "Sonstiges",
        brackets: {
          housing: "Wohnen & Fixkosten",
          subscriptions: "Abos & Medien",
          living: "Alltag & Verpflegung",
          professional: "Bildung & Gesundheit",
          leisure: "Freizeit & Kultur",
          other: "Sonstiges & Verbindlichkeiten",
          fixed_in: "Feste Einnahmen / Sperrkonto",
          variable_in: "Variable Einnahmen & Leihe"
        },
        months: MONTH_NAMES.de
      },
      en: {
        title: "Jdeeds' Household",
        subtitle: "Personal Cashflow & Ledger",
        startingCapital: "Starting Balance (Bank & Cash)",
        startingMonthLabel: "Balance at the start of",
        startingHint: "Your real balance at the start of the first month from which every income and expense is recorded. Earlier months don't count toward the reserve.",
        beforeStart: "Before the starting month",
        backCalcNote: "Worked back from the real balance entered for {{month}}",
        kpiActualNet: "Actual Net (Monthly Surplus)",
        kpiActualNetDesc: "Tap to see full receipt",
        kpiProjectedNet: "Projected Net",
        kpiDailyRoom: "Daily Allowance",
        kpiCumulative: "End balance",
        kpiCumulativeSub: "Month-end runway",
        kpiDailyRoomSub: "Available daily budget",
        endOfMonthTitle: "Expected balance end of {{month}}",
        endOfMonthTitlePast: "Balance end of {{month}}",
        carriedOver: "Carried over from {{month}}",
        carriedStart: "Starting balance",
        lineIncome: "Income",
        lineFixed: "Fixed costs",
        lineFlex: "Variable & one-time",
        receivedOf: "{{done}} of {{total}} received",
        paidOf: "{{done}} of {{total}} paid",
        paidCount: "{{n}} of {{m}} items paid",
        spentOf: "{{done}} spent · target {{total}}",
        targetLeft: "{{amount}} left of target",
        targetOver: "{{amount}} over target",
        stillOpen: "Still to pay: {{amount}}",
        stillExpected: "Still expected: {{amount}}",
        expectedRules: "How it's calculated: income = received, else planned · fixed & one-time = paid, else planned · variable groups = monthly target, or more if already exceeded. Finished months: only what really came in and went out.",
        thisMonth: "This month",
        breakdownBtn: "All amounts",
        fixBalanceBtn: "Correct with real balance",
        fixBalanceTitle: "Enter your real balance",
        fixBalanceTodayLabel: "Balance today (bank + cash)",
        fixBalanceStartLabel: "Balance at the start of {{month}} (bank + cash)",
        fixBalanceTodayDesc: "The carried-over amount is worked out from this and what's already entered for {{month}} (received {{in}}, spent {{out}}), so enter everything that already happened this month first. Older months stop counting after this.",
        fixBalanceStartDesc: "Calculations start from this amount in {{month}}. Older months stop counting after this.",
        fixBalancePreview: "Carried over becomes: {{amount}}",
        fixBalanceSave: "Apply",
        groups: {
          transport: "Transport",
          health: "Health & fitness",
          education: "Education & exams",
          fees: "Banking & fees",
          family: "Family & friends",
          kids: "Children",
          housing: "Housing",
          bills: "Bills & communication",
          subs: "Subscriptions",
          insurance: "Insurance",
          groceries: "Groceries & drugstore",
          household: "Household",
          clothing: "Clothes & shoes",
          leisure: "Leisure & eating out",
          oneoff: "One-time"
        },
        filterAll: "All",
        filterFixed: "Fixed",
        filterVariable: "Variable & one-time",
        moreTab: "Overview",
        groupLabel: "Group",
        groupPaidSub: "{{n}} of {{m}} paid · {{amount}} open",
        groupAllPaid: "All paid",
        groupNothingPlanned: "Nothing planned",
        groupTargetSub: "of {{target}} · {{left}} left",
        groupOverSub: "{{amount}} over the {{target}} target",
        groupNoTarget: "No monthly target yet",
        monthlyTarget: "Monthly target",
        monthlyTargetHint: "Applies from {{month}} onward",
        itemsCount: "{{n}} items",
        dueOn: "Due on the {{day}}.",
        notPaidYet: "Not paid yet",
        receivedLabel: "Received",
        expectedLabel: "Expected",
        receiptsCount: "{{n}} receipts",
        receiptsOne: "1 receipt",
        nothingYet: "Nothing yet",
        addReceipt: "Receipt",
        addReceiptTo: "Add receipt to {{name}}",
        addBtn: "Add",
        receiptAdded: "Added {{amount}} to {{name}} · {{group}}: {{spent}} of {{target}}",
        receiptAddedNoTarget: "Added {{amount}} to {{name}} · {{group}}: {{spent}}",
        receiptSheetTitle: "Add a receipt",
        receiptWhere: "Where did you spend it?",
        receiptNeedAmount: "Enter an amount first, then pick where you spent it.",
        receiptNoItems: "First add an item to a variable group, e.g. Netto.",
        spentTotalLabel: "Spent in {{month}} (total)",
        tapCircleHint: "Tap the circle when paid",
        tapPlusHint: "Tap + to add a receipt",
        addItemShort: "+ Add item",
        newGroup: "+ New group",
        groupDialogNew: "New group",
        groupDialogEdit: "Edit group",
        groupNameLabel: "Name",
        groupNamePlaceholder: "e.g. Car, Pet, Savings",
        groupKindLabel: "Type",
        groupColorLabel: "Color",
        groupKindHelp_fixed: "Known amounts you tick off as paid: rent, subscriptions, bills.",
        groupKindHelp_variable: "Collect receipts against one monthly target for the whole group: groceries, drugstore.",
        groupKindHelp_oneoff: "Single payments in a specific month: exam fee, deposit.",
        groupDelete: "Delete group",
        groupDeleteMove: "Move its {{n}} items to:",
        groupSave: "Save",
        actPeriod: "Period",
        actEdit: "Edit",
        markReceivedAria: "Mark {{name}} as received",
        markPaidAria: "Mark {{name}} as paid",
        groupFixed: "Fixed costs · rent, bills, subscriptions",
        groupFlex: "Variable & one-time",
        targetLabel: "Target",
        spentLabel: "Spent",
        paidLabel: "Paid",
        markPaid: "Paid",
        markReceived: "Received",
        markPaidHint: "Record the planned amount as paid",
        markReceivedHint: "Record the planned amount as received",
        kpiIn: "In",
        kpiOut: "Out",
        kpiProjPrefix: "Projected:",
        incomesHeader: "Incomes",
        expensesHeader: "Expenses",
        analyticsTab: "Overview & Debts",
        planLabel: "Plan",
        actualLabel: "Actual",
        asOfDayLabel: "Day",
        asOfDayHint: "Day of month the actual is counted up to. Empty = automatic (today).",
        restBudgetLabel: "Remaining",
        perDayLabel: "/ day",
        statusOver: "Over Budget",
        statusTrack: "On Track",
        statusFrugal: "Under Budget",
        badgeOneTime: "One-Time",
        badgeFixed: "Fixed",
        badgeVariable: "Variable",
        modeLabel: "Type",
        options: "Settings",
        themeLabel: "Appearance",
        themeLight: "Light",
        themeDark: "Dark",
        themeSystem: "System",
        cloudSync: "Cloud sync",
        signIn: "Sign in with Google",
        signOut: "Sign out",
        signedInAs: "Signed in as {{email}}",
        signInError: "Sign-in failed: {{msg}}",
        syncLocalOnly: "Saved on this device only. Sign in to sync across devices.",
        syncStatus_local: "Local only",
        syncStatus_pending: "Saving…",
        syncStatus_synced: "Synced",
        syncStatus_error: "Sync error – data is kept locally",
        backupSection: "Data & Storage",
        exportBackup: "Export JSON",
        importBackup: "Restore JSON",
        importSuccess: "Data restored successfully!",
        importError: "Corrupted file format.",
        clearAll: "Reset all data",
        confirmClear: "Do you really want to permanently delete all data?",
        showAllBtn: "0 € visible (Show all)",
        hideZeroesBtn: "0 € hidden",
        showZeroTitle: "Show 0 € items",
        hideZeroTitle: "Hide 0 € items",
        hiddenNoticeBracket: "{{count}} inactive items (0 €) hidden",
        showNow: "Show",
        expandAll: "Expand all",
        collapseAll: "Collapse all",
        annualOverview: "Annual View",
        annualRunway: "Runway & Annual Flow",
        annualSavingsRate: "Savings rate (projected)",
        annualMonth: "Month",
        annualNet: "Actual net",
        annualProjected: "Projected",
        annualBalance: "Balance",
        annualTotal: "Total",
        iouTitle: "Debts & Receivables (Loans / IOU)",
        iouAddBtn: "Add Record",
        iouPersonPlaceholder: "E.g. Sister (900€ loan)...",
        iouAmountPlaceholder: "Amount",
        iouOptBorrowed: "I owe (Loan/Debt)",
        iouOptLent: "Owed to me (Lent)",
        iouDebts: "Debts:",
        iouReceivables: "Receivables:",
        iouSisterTip: "Borrowed money from sister (900 €)?",
        iouSisterHint: "Adds +{{amount}} as income in {{month}} and schedules two {{half}} repayments in {{m1}} & {{m2}}.",
        iouSisterBtn: "⚡ Record Loan Received & Plan Repayments",
        iouIOweBadge: "I owe",
        iouOwedToMeBadge: "Owed to me",
        iouMarkReturned: "Mark as settled",
        iouLoanLink: "Record a loan and plan repayments",
        iouDelete: "Delete (entered by mistake)",
        iouDeleteConfirm: "Delete \"{{person}} · {{amount}}\"? This only removes this entry from the debt list, not the income or the repayments.",
        loanDuplicateWarn: "You already recorded a loan of {{amount}} ({{person}}, {{date}}). Booking it again counts the income, the repayments and the debt twice.",
        emptyGroupIncomes: "No active income records in this month.",
        emptyGroupExpenses: "No expenses in this group for this month.",
        editorTitle: "Edit Property",
        posten: "Item Name",
        bracketLabel: "Category",
        paymentDayShort: "Due",
        deleteCategoryBtn: "Delete",
        saveClose: "Save & Close",
        addItemBtn: "+ New Item",
        notesTitleMonth: "Notes & Receipts ({{month}} {{year}})",
        addNotePlaceholder: "Add note or receipt item...",
        quickAddModalTitle: "Add New Item",
        quickAddNamePlaceholder: "E.g. Sister Repayment, Netflix...",
        initialBudgetLabel: "Planned Amount (€)",
        isOneTimeCurrentOnly: "Only in the \"From\" month (0 € in every other month)",
        rangeFrom: "From",
        rangeUntil: "Until",
        rangeSummary: "{{n}} months: {{from}} – {{until}}",
        rangeSummaryOne: "1 month: {{from}}",
        repeatLabel: "Repeat",
        repeat1: "Every month",
        repeat2: "Every 2 months",
        repeat3: "Every 3 months (quarterly)",
        repeat6: "Every 6 months",
        repeat12: "Once a year",
        paymentsSummary: "{{n}} payments: {{list}}",
        quickStores: "Quick add:",
        importTitle: "Import bank statement",
        importBtn: "⬇ Import",
        importAccount: "Which account?",
        importOwn: "{{name}}'s account",
        importJoint: "Joint account",
        importFrom: "Only entries from",
        importFromHint: "Months you already entered by hand would otherwise count twice.",
        importChoose: "Choose file (CSV, Excel or PDF)",
        importHowTo: "Revolut: open the account → “…” → Statement → CSV or Excel (the “consolidated” statement with all accounts works too). Wise: account → Statements → CSV. Sparkasse, Volksbank & co.: the PDF statement from online banking, or the CSV transactions. Money Manager (Excel) works too.",
        importBadFile: "This file couldn't be read. It should be a bank statement (CSV, Excel or PDF) with a date, description and amount.",
        importSummary: "{{file}}: {{n}} lines · {{ready}} matched · {{dup}} already imported · {{skipped}} skipped",
        importSelectAll: "Select all with a suggestion",
        importSelectNone: "Select none",
        importSkipOption: "— don't import —",
        importNewItem: "New: {{name}}",
        importNothingNew: "No new entries in this file.",
        importSkippedList: "Show {{n}} skipped lines",
        importSkip_dup: "already imported",
        importSkip_state: "not completed",
        importSkip_currency: "other currency",
        importSkip_range: "outside May 2026 – Dec 2028",
        importSkip_before: "before the chosen date",
        importSkip_exchange: "currency exchange",
        importSkip_future: "in the future (stays planned)",
        importSkip_entered: "already entered by hand (same day and amount)",
        importTotals: "Selected: + {{inSum}} in · − {{outSum}} out · net {{net}}",
        importThenBalance: "now use “Correct with real balance”",
        importRun: "Import {{n}} entries",
        importDone: "Imported {{n}} entries",
        importOwnTransfer: "Own transfer",
        importReplacesTick: "replaces your tick",
        importTransfersNote: "{{n}} transfers between your own accounts found. They're neither income nor spending, so they stay unticked.",
        dueTitle: "Due soon",
        dueOverdue: "Overdue since {{month}} {{day}}",
        dueOnDay: "Due {{month}} {{day}}",
        dueInMonth: "In {{month}}",
        dueMore: "+ Show {{n}} more",
        dueLess: "Show less",
        dueThis: "This month",
        dueNext: "Next",
        dueBoth: "Both",
        dueNothing: "All paid 🎉",
        dueNoDay: "No fixed day",
        forecastTitle: "Outlook: month-end balance (12 months)",
        incomeEndTitle: "Income ending",
        incomeEndLast: "Last payment: {{when}}",
        incomeEndFrom: "missing from {{month}}",
        incomeEndTotal: "From {{month}}, {{amount}} less per month in total.",
        incomeEndHint: "Plan in time how to replace it: a buffer, lower costs or new income. The red line in the outlook shows when it stops.",
        forecastLow: "Lowest point: {{amount}} at the end of {{month}}",
        forecastNegative: "Careful: at the end of {{month}} you'd be at {{amount}}",
        setAsideTitle: "Set aside",
        setAsideHint: "Irregular and upcoming one-time payments, spread over the months. Put this aside every month and they won't catch you off guard.",
        setAsideRhythm: "{{n}}× in 12 months · next {{month}}",
        setAsideOnce: "once in {{month}}",
        perMonthShort: "{{amount}}/month",
        goalsTitle: "Savings goals",
        goalNew: "+ Goal",
        goalNewTitle: "New savings goal",
        goalEdit: "Edit savings goal",
        goalsEmpty: "No savings goals yet, e.g. emergency fund, phone or holiday.",
        goalNamePlaceholder: "e.g. Emergency fund",
        goalTarget: "Target",
        goalSaved: "Saved so far",
        goalDeadline: "By when?",
        goalNoDeadline: "No deadline",
        goalHint: "Savings goals don't count in the monthly budget. They only track how much you've put aside.",
        goalReached: "Goal reached 🎉",
        goalPerMonth: "{{amount}}/month until {{month}}",
        goalLeft: "{{amount}} to go",
        goalDeposit: "+ Add savings",
        goalDeposited: "Saved {{amount}} for \"{{name}}\"",
        goalDeleteConfirm: "Delete the savings goal \"{{name}}\"?",
        iouRepaid: "{{repaid}} of {{total}} repaid (through \"{{item}}\")",
        iouLinkRepay: "Link repayments to …",
        reportGroups: "Spending by group {{year}}",
        reportAvgNote: "Average over {{n}} months with spending.",
        reportTopItems: "Biggest items",
        reportWhoNote: "From single entries (receipts and imports).",
        membersLabel: "Household (names)",
        autoBackups: "Automatic backups (this device)",
        autoBackupsEmpty: "None yet. From your next change on, one backup is kept per day.",
        autoBackupsHint: "One backup per day, the last 14 days. A restore can be undone.",
        autoBackupRestore: "Restore",
        autoBackupConfirm: "Restore the state from {{day}}? Everything after it is replaced.",
        autoBackupRestored: "Backup restored",
        beforePaydayTitle: "Left until next payday · {{month}}",
        beforePaydayLine: "Before the next payday",
        carriedBeforeSalary: "Left before {{month}}'s salary",
        linePaidEndPrev: "Paid end of {{month}} (for this month)",
        leavingForNext: "Goes out end of {{month}} for {{next}}",
        forNextExpLabel: "Paid from the next salary",
        forNextExpHelp: "Paid only after the salary at the end of the month (e.g. rent on the 28th), so it counts in the next month. Enter it in the month it's paid.",
        lineIncomeFromPrev: "Salary from {{month}} (for this month)",
        lineIncomeThis: "Other income in {{month}}",
        arrivingForNext: "Arrives end of {{month}} for {{next}}",
        availableNow: "In the accounts now (per entries)",
        forNextBadge: "→ for {{month}}",
        forNextLabel: "For next month",
        forNextHelp: "Arrives at the end of the month (e.g. on the 26th) and is spent in the next one. Enter it in the month it arrives; it counts in the next.",
        shiftTip: "Does your salary arrive at the end of the month? Open it under Income → ✎ Edit → \"For next month\". This number then shows what's really left until the next payday.",
        paydayLabel: "Salary arrives on the",
        paydayOff: "No fixed day (calendar month)",
        paydayOption: "{{day}}th (budget month: {{day}}th to {{until}}th)",
        paydayHelp: "Your budget month starts with the salary. Bills due on or after this day and receipts from this date on count for the next month automatically, including for the monthly target.",
        forNextAuto: "Counts for the next month automatically (due day {{day}} ≥ payday {{payday}})",
        countsForNext: "Counts for {{month}}",
        whoJoint: "Joint",
        whoLabel: "Who paid?",
        whoPaidTitle: "Who paid? (expenses)",
        noteLabel: "Note (optional)",
        dateLabel: "Date",
        undoBtn: "Undo",
        txDeleted: "Deleted {{amount}} at {{name}}",
        entriesLabel: "Entries ({{n}})",
        txBtn: "Entries",
        navOverview: "Overview",
        navMonth: "Month",
        navActivity: "Activity",
        navPlan: "Plan",
        navMore: "More",
        prevMonth: "Previous month",
        nextMonth: "Next month",
        todayBtn: "Today",
        dismiss: "Dismiss",
        heroIn: "In",
        heroOut: "Out",
        heroStart: "Start",
        heroDetails: "Show calculation",
        heroHide: "Hide calculation",
        howCalc: "How is this calculated?",
        quickReceipt: "Receipt",
        quickImport: "Import",
        quickAsk: "Ask",
        quickHistory: "History",
        incomeEndShort: "{{n}} incomes end · from {{month}} {{amount}} missing",
        showDetails: "Details",
        hideDetails: "Less",
        emptyItems: "{{n}} without amount",
        hideEmpty: "Hide empty",
        emptyGroups: "Nothing this month ({{n}})",
        actEntries: "Receipts",
        actHistory: "History",
        actSummary: "Month summary",
        planYear: "Year",
        planOutlook: "Outlook",
        accountsTitle: "Accounts",
        accountsIntro: "Enter your real balances now and then – the app compares them with its numbers.",
        accountsSetup: "Add our accounts",
        accountAdd: "+ Account",
        accountMain: "Main accounts",
        accountGateway: "Gateway accounts",
        accountCash: "Cash",
        accountsTotal: "Total",
        accountsAppNow: "App says now",
        accountsDiff: "Difference",
        accountsUse: "Use as real balance",
        accountsUsed: "Balance applied: {{amount}}",
        accountsUpdated: "checked {{day}}",
        accountName: "Name",
        accountsMatch: "Matches ✓",
        accountRemoved: "Account removed",
        entrySaved: "Entry saved",
        entryTitle: "Edit entry",
        itemFromBank: "Bank",
        itemGroupOf: "{{group}}: {{spent}} of {{target}}",
        itemOfPlan: "of {{plan}} planned",
        itemNoPlan: "No plan for this month",
        itemAdd: "Add",
        itemPaid: "Paid",
        itemReceived: "Received",
        itemMarkPaid: "Mark paid",
        itemMarkReceived: "Mark received",
        itemSettings: "Settings",
        itemEntries: "Entries this month ({{n}})",
        itemNoEntries: "Nothing entered yet.",
        edPlanCard: "Plan & repeat",
        stillIn: "Still coming in this month",
        stillOut: "Still going out this month",
        accountSavings: "Savings",
        savingsOutItem: "Savings",
        savingsInItem: "From savings",
        savingsHint: "Money in savings accounts doesn’t count as spendable. Move money there or back with Add → Transfer.",
        fixTitle: "{{n}} of your entries are also in this statement",
        fixHint: "Who paid and which account, as the statement says. Untick what should stay as it is.",
        fixBtn: "Fix {{n}} entries",
        fixDone: "{{n}} entries fixed",
        labsTitle: "New features (switch off one by one)",
        labsNowToday: "“Now” without entries after today",
        labsReminders: "Reminders for due bills",
        labsImportAmount: "Import matches bills by amount",
        labsCloseMonth: "Month-end card",
        labsSplitUp: "Who paid what",
        srchTitle: "Search",
        srchPh: "Shop, item, note or amount – e.g. Action",
        srchAll: "All years",
        srchFound: "{{n}} entries",
        srchHint: "Type at least 2 characters.",
        cmTitle: "Close {{month}}",
        cmSub: "{{n}} days left",
        cmStepAccounts: "Enter your account balances (so “Now” is right).",
        cmOpenAccounts: "Open accounts",
        cmStepBillsOpen: "{{n}} bills still open ({{amount}}).",
        cmStepBillsDone: "All bills paid.",
        cmStepLeftover: "Left in the shopping budgets: {{amount}}",
        cmToGoal: "Put {{amount}} into goal",
        cmNoGoal: "Create a savings goal under “Plan” to put the rest there.",
        suTitle: "Who paid what",
        suEven: "You paid about the same this month.",
        suOwes: "{{who}} gives {{to}} {{amount}} and you’re even.",
        suHint: "Only entries with “Who?” – joint spending isn’t counted.",
        remTitle: "Reminders ({{n}})",
        remAllow: "Turn on phone notifications",
        rem_overdue: "overdue",
        rem_today: "due today",
        rem_tomorrow: "due tomorrow",
        rem_late: "not arrived yet",
        acctSince: "Since {{day}}: {{n}} entries, {{delta}}",
        acctExpected: "→ use {{amount}}",
        futureNote: "Booked for after today – not in the bank yet",
        loanDupSpare: "duplicate – this copy can go",
        loanSettledList: "Settled loans ({{n}})",
        loanPaidVia: "paid back via “{{item}}”: {{amount}}",
        loanNoLink: "no repayment item",
        loanDup: "duplicate?",
        loanReopen: "Reopen",
        loanSettledToast: "Loan settled – open planned repayments removed",
        pmToggle: "Different every month",
        pmDefault: "Amount for months without their own value (€)",
        pmList: "{{n}} months · {{total}} in total",
        pmUsePaid: "Use paid amounts ({{n}})",
        pmHint: "Change any month on its own. ✓ = already paid that month.",
        kWhatKind: "What is it?",
        kPurchase: "Purchase",
        kBill: "Bill (monthly)",
        kSub: "Subscription",
        kOnebill: "One-time bill",
        kOneoffIn: "One-off",
        kRegularIn: "Regular",
        kEvery: "Every",
        kMonth1: "month",
        kMonthsN: "{{n}} months",
        kOnDay: "due on day",
        kOnDayIn: "arrives on day",
        kDueOn: "Due on {{date}} (change the date below)",
        kPaidNow: "Already paid (book it now)",
        kReceivedNow: "Already received (book it now)",
        kHintRepeatPaid: "Planned every {{every}} from this month on, and this payment is booked.",
        kHintRepeatLater: "Only planned – it shows in “Due soon” until you tick it off.",
        kHintOnebillPaid: "Planned once and booked as paid right away.",
        kHintOnebillLater: "Planned once – it shows in “Due soon” and in the calendar.",
        kBillCard: "{{month}}: {{plan}} planned",
        kDueDay: "due on the {{d}}.",
        kAlreadyPaid: "Already paid ({{amount}}) – booking again counts twice.",
        kPartPaid: "{{amount}} paid so far.",
        bkPlanned: "“{{name}}” planned – nothing paid yet.",
        selStart: "Select",
        selDone: "Done",
        selMonth: "This month ({{n}})",
        selAllMonths: "All months ({{n}})",
        selNotPlan: "All except {{amount}} ({{n}})",
        selNone: "None",
        moveTo: "Move to… (pick an item or type a new one)",
        moveBtn: "Move {{n}}",
        moveNew: "A new item “{{name}}” will be created.",
        movedToast: "{{n}} entries → {{to}}",
        entryItemSettings: "Edit item",
        entryCreate: "Create “{{name}}”",
        entryMoveAll: "Also move the {{n}} other {{amount}} entries from “{{from}}” (e.g. earlier months)",
        motionLabel: "Animations",
        motionOn: "On",
        motionOff: "Off",
        shopAllItems: "All items…",
        shopNewItem: "New item",
        shopWhat: "What did you buy at {{shop}}?",
        shopKeep: "Or tap nothing – then it stays as “{{shop}}”.",
        shopBoughtAt: "Bought at {{shop}} → {{item}}",
        splitBtn: "Split across items",
        splitTitle: "Split",
        splitCancel: "Don't split",
        splitRest: "rest",
        splitAdd: "Another item",
        splitTooMuch: "The parts add up to the whole amount or more – nothing is left for the first item.",
        logoSearch: "Search a logo or type a website – e.g. DB, goldsgym.de",
        logoNone: "No logo found – pick a symbol below.",
        mergedToast: "“{{from}}” is now part of “{{to}}”",
        dcSame: "“{{a}}” and “{{b}}” look like the same thing.",
        dcMergeInto: "Merge into “{{name}}”",
        mergeLabel: "Merge into",
        mergePick: "Choose item…",
        mergeConfirm: "Move all entries, plans and notes from “{{from}}” to “{{to}}” and remove “{{from}}”?",
        schNow: "Now:",
        schFrom: "from {{month}}",
        schFirst: "first payment {{amount}}",
        schEveryMonth: "then {{amount}} every month",
        schEveryN: "then {{amount}} every {{n}} months",
        schOpenEnd: "no end",
        schUntil: "until {{month}}",
        schOdd: "{{n}} month(s) with a different amount – kept as long as you change nothing here.",
        schFirstToggle: "First payment is different",
        schFirstLabel: "First payment (€)",
        schThenLabel: "After that, each (€)",
        calNothingDay: "No payments on this day",
        otAdd: "Add through \"Add\"",
        calKind_earlier: "Entered earlier",
        calKind_loan: "Loan",
        calLegShops: "shops & groups",
        calLegTap: "double-tap = day view",
        tipsTitle: "AI suggestions",
        tipsSub: "Personal tips for this month",
        tipsFrom: "As of {{when}}",
        tipsGet: "Get suggestions",
        tipsRefresh: "Refresh",
        tipsIntro: "The AI looks at your current month (targets, bills, balance, savings rate) and gives 3–5 short, concrete tips. Only when you tap – each request costs a few cents of API credit.",
        tipsOtherLang: "These tips are in another language – \"Refresh\" gets them in the current one.",
        calModeMonth: "Month",
        calModeDay: "Day",
        calLegGroups: "colour = group",
        edTabDetails: "Details",
        edTabPeriod: "Amounts & period",
        actEditAll: "Edit",
        starterBtn: "Family starter kit",
        starterDone: "Starter kit added: incomes, bills, children and shops",
        starterHint: "Adds typical incomes (2× blocked account, Kindergeld), bills, children items and shops – only what is missing.",
        rcPhoto: "Photograph receipt",
        rcHint: "Tip: 📷 photograph a receipt – the AI fills in shop, amount and date.",
        rcBusy: "Reading the receipt …",
        rcNone: "Couldn't read a total on the photo.",
        rcRead: "Read: {{amount}} · {{shop}} – check and save",
        ovArrange: "Arrange cards",
        ovArrangeHint: "Change the order of the cards on Overview or hide some (eye). Saved on this device.",
        ovToggle: "Show/hide",
        ovReset: "Reset",
        ovDone: "Done",
        ovN_review: "Month review",
        rvTitle: "Review of {{month}}",
        rvSubPlus: "{{amount}} more came in than went out",
        rvSubMinus: "{{amount}} more went out than came in",
        rvDone: "Done",
        rvIn: "Came in",
        rvOut: "Went out",
        rvNet: "Result",
        rvPlanned: "planned",
        rvSurprises: "More than planned:",
        rvBiggest: "Biggest items:",
        rvCheckBal: "Check account balances",
        rvHint: "A quick look at the start of each month: if the balances are right, the new month starts with correct numbers.",
        bkTransfer: "Transfer",
        trFrom: "From account",
        trTo: "To account",
        trMove: "Update account balances",
        trMoveHint: "Takes the amount off one account and adds it to the other. Never counts as income or spending.",
        trNeedAccounts: "Please choose two different accounts.",
        trSaved: "{{amount}} moved: {{from}} → {{to}}",
        trDeleted: "Transfer deleted",
        calKind_transfer: "Transfer",
        dcTitle: "Data check",
        dcSub: "{{n}} things make the numbers less exact",
        dcUndated: "{{n}} bills have no due day – tap one to set it:",
        dcGap: "Your accounts show {{real}}, your entries {{app}} – {{diff}} apart. Something is missing or entered twice.",
        dcUseReal: "Use real balance",
        dcCheckAccounts: "Check accounts",
        dcDupLoan: "\"{{person}}\" · {{amount}} is entered {{n}}× as a loan – a duplicate?",
        dcReview: "Review",
        dcLoanMoney: "{{n}} older loans aren't checked against your balance yet.",
        dcNoDate: "{{n}} purchases this month have no day ({{amount}}), so they are missing from the calendar. Tap one, pick its day and save.",
        dcOpenAdd: "Go to Add",
        bkRepeat: "Recent – tap to repeat",
        bkLeft: "{{amount}} left after this",
        bkOver: "This puts you {{amount}} over the target",
        bkNoPlan: "No target set for this month.",
        bkSearchBig: "Search a shop or item – e.g. Netto, Kita, DHL",
        bkFound: "{{n}} of your items found",
        bkOther: "Other",
        bkMoreSugg: "+ {{n}} more",
        bkSuggest: "Create new – tap to pick:",
        calPaid: "Paid",
        calGot: "Received",
        calStillDue: "Still due",
        calDue: "Due",
        calExpected: "Expected",
        calKind_receipt: "Receipt",
        calKind_bill: "Bill",
        calKind_spent: "Spent",
        calKind_income: "Income",
        calLegPaid: "paid",
        calLegDue: "still due",
        calLegIn: "income",
        calUndated: "Without a day this month: {{n}} items · {{amount}}",
        calUndatedHint: "These items have no due day. Set the day on the item (or add purchases through \"Add\") and they appear in the calendar.",
        navBook: "Add",
        bkOut: "Expense",
        bkIn: "Income",
        bkAmount: "Amount",
        bkWhere: "What for?",
        bkWhereIn: "From where?",
        bkSearch: "Search …",
        bkNew: "New",
        bkNewName: "Name, e.g. Rewe",
        bkAll: "Show all {{n}}",
        bkLess: "Show less",
        bkWhen: "When?",
        bkToday: "Today",
        bkYesterday: "Yesterday",
        bkAccount: "Account",
        bkNoAccount: "None",
        bkWho: "Who?",
        bkNote: "Note (optional)",
        bkSave: "Save",
        bkSaved: "Saved {{amount}} · {{name}} · {{date}}",
        bkNeedAmount: "Please enter an amount.",
        bkNeedCat: "Please choose what it was for – or tap \"New\".",
        bkNeedDate: "This date is outside the plan.",
        calTitle: "Calendar",
        calTotal: "{{amount}} · {{n}} entries",
        calEmpty: "Nothing entered this month yet – everything you add on the left shows up here on its day.",
        calDayEmpty: "Nothing entered on this day.",
        calAddHere: "+ Add on this day",
        calNote: "Each entry counts towards its item in that month (like a receipt). The darker a day, the more was spent; a green dot means income. Amounts typed straight into Month have no date and don't appear in the calendar.",
        abRealBal: "Real balance (accounts, checked {{date}})",
        abRealDiff: "Your entries say {{amount}}. Keep the balances under More → Accounts up to date and this number stays exact.",
        abNoReal: "Enter your real balances under More → Accounts and this card will start from them.",
        abNowBal: "Balance now (per entries)",
        abFitsNow: "Groceries etc. still have {{month}} planned this month; for day {{from}}–{{to}} that is about {{amount}} – that fits.",
        abTightNow: "Careful: groceries etc. still have {{month}} planned; for day {{from}}–{{to}} that would be about {{amount}} – more than is available.",
        abSpendUntil: "To spend until {{month}} {{day}}",
        abSpendMonth: "To spend this month",
        abPerDay: "≈ {{amount}} a day for {{n}} days (day {{from}} to {{to}})",
        abNothing: "After the bills there is nothing left until the next money comes in.",
        abLowest: "Lowest point ({{month}} {{day}})",
        abLateIn: "Coming in from day {{day}}",
        abEnd: "End of {{month}} (before variable)",
        abFits: "Your targets for groceries etc. ({{month}}/month) need about {{amount}} for day {{from}}–{{to}} – that fits.",
        abTight: "Careful: your targets for groceries etc. need about {{amount}} for day {{from}}–{{to}} – more than is available.",
        abUndated2: "Without a date: {{b}} bills count from day 1 and {{i}} incomes only at month end, to be safe. Set the due day on the item.",
        abHint2: "The line is your balance day by day with only income and bills (no groceries etc.). Its lowest point from today on is what you can spend on variable things before the next money arrives without going below zero. For this month it starts from your balance right now (everything received and spent so far, groceries included); for next month from this month's expected end.",
        forecastTitleAll: "Month-end balance: history & outlook",
        forecastNext: "Next",
        forecastAll: "All",
        abTitle: "After the bills",
        abThis: "This",
        abNext: "Next",
        abOnDay: "Left on {{month}} {{day}}",
        abFree: "Free after all bills",
        abStart: "Balance at month start",
        abIncome: "Income this month",
        abBills: "Bills & fixed costs",
        abVariable: "Targets for variable (groceries …)",
        abAfterVariable: "Left to save",
        abLateIncome: "Arrives after day {{day}}: {{list}}.",
        abShowList: "Show all {{n}} bills",
        abHideList: "Hide list",
        abShowList2: "Show all {{n}} payments in and out",
        abUndated: "{{n}} bills without a date are already counted by day {{day}}, to be safe.",
        abHint: "Balance at month start = expected balance at the end of the month before. \"Left on day {{day}}\" = balance + income arriving by then − bills due by then (bills without a date count too). \"Free\" = balance + all income − all bills and fixed costs of the month; groceries and other variable spending still come out of it, the rest can be saved. Set the due day on each item.",
        noAccessTitle: "No household for this account yet",
        noAccessText: "{{email}} isn't allowed into any household yet. The names you see are only placeholders. Ask the owner to add this address to the Firebase rules, then reopen the app.",
        householdLabel: "Household",
        householdUnnamed: "Unnamed household",
        householdNew: "Start a new household",
        hhWelcome: "Welcome to your new household",
        hhWelcomeText: "This household is empty and completely separate from any other. Give it a name and enter your names – items and groups can be adjusted afterwards in Month.",
        hhNamePh: "Household name",
        hhMePh: "Your name",
        hhPartnerPh: "Partner's name",
        hhWelcomeHint: "Set the starting balance and month in Settings (⚙).",
        hhDone: "Done",
        loanMoneyTitle: "In your balance",
        loanCountedIn: "{{amount}} counted as income in {{month}} (\"{{item}}\").",
        loanCountedOut: "{{amount}} counted as an expense in {{month}} (\"{{item}}\").",
        loanCountedEarlier: "Already counted in your balance earlier.",
        loanUnbook: "Undo",
        loanNotCounted: "Not in your balance – not counted {{kind}} yet.",
        loanMaybeCounted: "Older loan: is the money already entered {{kind}}? If not, book it into the right month here.",
        loanAsIncome: "as income",
        loanAsExpense: "as an expense",
        loanBookInBtn: "Book as income",
        loanBookOutBtn: "Book as expense",
        loanAlreadyCounted: "It's already in",
        loanBookedToast: "Loan booked into your balance",
        loanUnbookedToast: "Booking undone",
        loanListNotCounted: "Not in your balance – tap to book it {{kind}}",
        loanListCheck: "In your balance? Tap to check and book",
        editStart: "Edit",
        editDone: "Done",
        editOnToast: "Editing on – fields can be changed",
        editOffToast: "View mode – fields are locked",
        wgTitle: "Where the money went · {{month}}",
        wgSpent: "spent",
        wgNone: "No spending recorded for last month yet.",
        wgFlow: "Income and what it went to",
        wg_needs: "Needs",
        wg_wants: "Wants",
        wg_once: "One-time",
        wg_debt: "Debt repaid",
        wg_left: "Left over",
        wgShort: "{{amount}} more spent than came in",
        wgHint: "The ring shows last finished month's spending by group (savings and loans left out). The bar splits that month's income into needs, wants, one-time costs, debt repaid and what was left over.",
        ycEvery: "every {{n}} mo",
        ycShowAll: "Show all {{n}}",
        ycShowLess: "Show less",
        loanRate: "Interest per year in % (optional)",
        healthTitle: "Money health",
        healthSub: "Savings cover {{n}} months",
        healthSubNone: "Emergency fund, savings rate, needs & wants",
        healthWhy: "Why?",
        efTitle: "Emergency fund",
        efMonths: "{{n}} months",
        efCore: "Core costs {{amount}} / month",
        efHave: "You have",
        ef3: "Target 3 months",
        ef6: "Target 6 months",
        efNoAccounts: "Based on the app balance. Enter your real balances under More → Accounts for a more exact number.",
        efHint: "Core costs = what you really need each month (rent, bills, insurance, groceries …), averaged over the last 3 finished months; groups marked as \"want\" and one-time items are left out. Aim for 3 months at least, 6 for more safety, ideally in an instant-access savings account that pays interest.",
        srTitle: "Savings rate",
        srRule: "Save first:",
        srOff: "Off",
        srPayday: "Set aside {{amount}} this month ({{pct}} % of {{income}} income) – best on payday.",
        srDone: "Done ✓",
        srSoFar: "Booked to \"savings\" so far: {{amount}}",
        srHint: "Savings rate = (income − spending) ÷ income. Loans and transfers to/from savings are left out; paying back debt counts as saved because it lowers what you owe. Saving a fixed percentage means every pay rise automatically saves more.",
        nwTitle: "Needs & wants",
        nwShare: "Wants share in {{month}}",
        nwWant: "want",
        nwNeed: "need",
        nwRising: "Your wants share has been rising for 3 months.",
        nwHint: "Tap a group to mark it as a need or a want. Rule of thumb 50/30/20: about half for needs, up to 30 % for wants, 20 % saved. Spend freely on what you truly love and cut back on the rest.",
        ycTitle: "Regular costs per year",
        ycAll: "All regular costs / year",
        ycSubs: "Of which subscriptions / year",
        ycFees: "Bank fees (last 12 months)",
        ycHint: "Monthly amounts look small; per year you see what a contract really costs. Once a year, check every contract and cancel what you don't use.",
        dbTitle: "Debts by interest",
        dbNone: "No open debts.",
        dbExpensive: "Pay off debts above 8 % interest before you invest.",
        dbHint: "Pay off the most expensive debt first. Enter the interest on the loan (✎). An interest-free family loan is cheap – no rush, but repay it reliably.",
        wtTitle: "Net worth",
        wtNow: "Today (money − debts + owed to you)",
        wtHint: "The line is your money at each month's end according to the app; the green dot is today. Net worth = money minus open debts plus money others owe you. Income pays for your life; net worth buys your freedom.",
        wlTitle: "Wishlist (72 hours)",
        wlSub: "Buy wants only after 3 days",
        wlSaved: "{{amount}} saved by skipping",
        wlNamePh: "What would you like to buy?",
        wlAdd: "Add wish",
        wlEmpty: "A new want over 50 €? Add it here and wait 3 days.",
        wlWait: "{{h}} h left to wait",
        wlReady: "Do you still want it?",
        wlSkip: "Skip",
        wlBuy: "Buy",
        wlSkippedN: "{{n}} wishes skipped · {{amount}} saved",
        newLoanTitle: "New loan",
        loanNewBtn: "New loan",
        loanNoneOpen: "No open loans.",
        loanBorrowed: "I borrowed",
        loanLent: "I lent",
        loanBorrowerLabel: "To whom?",
        loanPersonPh: "e.g. Sister, Aram …",
        loanBookIn: "Book as income in {{month}}",
        loanBookOut: "Book as expense in {{month}}",
        loanBookHint: "Turn off if the money didn't go through your accounts.",
        loanInstallments: "Pay back in instalments",
        loanBackInstallments: "Repayment expected in instalments",
        loanNoPlan: "None",
        loanFirstMonth: "First instalment",
        loanPreview: "{{n}} × {{amount}} · {{months}}",
        loanSave: "Save",
        loanFromItem: "Loan from",
        loanRepayItem: "Repayment to",
        lentToItem: "Lent to",
        repaidByItem: "Repayment from",
        loanAdded: "Loan saved: {{amount}} · {{person}}",
        loanNeedFields: "Please enter a person, an amount and a date.",
        loanShared: "This repayment plan covers {{n}} loans together ({{amount}}); payments go to the oldest first.",
        loanEditTitle: "Edit loan",
        loanEditExisting: "Edit the existing loan instead",
        loanPerson: "Person",
        loanAmount: "Amount",
        loanDate: "Date",
        loanType: "Type",
        loanSchedule: "Repayment plan",
        loanPlan: "Planned",
        loanPaid: "Paid",
        loanAddMonth: "+ Add a month …",
        loanRemaining: "Not planned yet",
        loanPlannedOk: "All planned ✓",
        loanPlannedGap: "The repayments don't add up to the full amount yet. Add a month or change an amount.",
        loanNoSchedule: "No repayment planned yet.",
        iconLabel: "Icon",
        iconAuto: "Automatic",
        iconAi: "AI suggestion",
        iconsAiTool: "Find missing icons with AI",
        iconsDone: "{{n}} icons set",
        iconsNone: "No fitting icons found.",
        gestureTip: "Tip: swipe sideways to change month · pinch with two fingers to fold all groups, spread to unfold them.",
        loansTitle: "Loans & debts",
        toolsTitle: "Tools",
        toolSettings: "Settings & backup",
        toolGroups: "New group",
        toolLang: "Language: English",
        tidyTitle: "Tidy up categories",
        tidyIntro: "Suggestion: move {{n}} items into better-fitting groups.",
        tidyApply: "Apply",
        tidyDone: "{{n}} items re-sorted",
        tidyNone: "Everything is already well sorted.",
        addReceiptShort: "Add receipt",
        sectionMonth: "Month",
        logBtn: "History",
        askBtn: "Ask",
        askTitle: "Household assistant",
        askIntro: "Ask anything about your numbers – in English, German or Arabic. The assistant reads your entries but never changes them.",
        askEx1: "How much did we spend on groceries since September?",
        askEx2: "Why is November lower than October?",
        askEx3: "Does anything not add up this month?",
        askPlaceholder: "Type a question …",
        askSend: "Send",
        askNew: "New conversation",
        askThinking: "Thinking …",
        askPrivacy: "Your numbers are sent to Claude (Anthropic) to answer.",
        askNeedSignIn: "Please sign in with Google first (Settings).",
        askErrSetup: "The assistant isn't set up yet (API key in Vercel missing or wrong).",
        askErrNotAllowed: "This Google account isn't allowed to use the assistant (ALLOWED_EMAILS in Vercel).",
        askErrBusy: "Too many requests right now – please try again shortly.",
        askErrRefused: "The assistant can't answer that. Please rephrase.",
        askErrOffline: "No internet connection.",
        askErrGeneric: "That didn't work. Please try again.",
        logTitle: "Change history",
        logAll: "All",
        logEmpty: "No changes saved yet. From now on every change is kept here with its date.",
        logPlan: "plan changed",
        logReceived: "received",
        logPaid: "paid",
        logTxAdd: "receipt of {{day}} added",
        logTxDel: "receipt of {{day}} deleted",
        logTxEdit: "receipt of {{day}} changed",
        logStart: "Starting balance",
        logBulk: "{{n}} values changed at once (import or restore)",
        logNote: "The last {{n}} changes are kept with your data and synced.",
        viewEnd: "Month end",
        viewNow: "Now",
        nowTitle: "Balance now (per entries)",
        nowReceived: "Received so far",
        nowPaid: "Paid & spent so far",
        nowStillOpen: "Still open until month end",
        nowRules: "Counts only what is ticked or entered. Open plans are added only in “End of month”.",
        txModalTitle: "Entries {{month}}",
        txEmpty: "No single entries yet. Receipts and imported bank statements show up here.",
        rangeMonth: "Month",
        howOften: "How often?",
        recurringLabel: "Recurring",
        recurringHelp: "Comes back every month or on a fixed rhythm.",
        onceHelp: "Just once, in one month. It doesn't appear in any other month.",
        variableItemHelp: "No fixed amount: add receipts with +. The monthly target covers the whole group.",
        clearOutside: "Set the plan to 0 outside this period",
        clearOutsideHint: "Removes the plan from every other month. Actual amounts stay unchanged.",
        replicateTitle: "Set amount for a period",
        replicateCatLabel: "Category",
        replicateFieldLabel: "Which value?",
        replicateBudgetOption: "Plan (Budget)",
        replicateActualOption: "Actual (Spent)",
        replicateAmountLabel: "Amount (€)",
        replicateDurationLabel: "Duration",
        duration3: "3 Months ({{month}} + 2)",
        duration6: "6 Months ({{month}} + 5)",
        duration12: "12 Months (1 Year)",
        durationAll: "Until end of 2028",
        replicateActionBtn: "Apply",
        loanModalTitle: "Record Loan",
        loanModalDesc: "Adds the received cash as income and schedules the repayments as expenses in the chosen months:",
        loanStep1: "1. Money received (income for {{month}} {{year}})",
        loanStep2: "2. Plan repayment (expenses)",
        loanReceivedAmountLabel: "Money received",
        loanLenderLabel: "Borrowed from whom?",
        loanIncomeCatLabel: "Income Item Name",
        loanExpenseCatLabel: "Repayment Item Name",
        loanInst1Month: "1st repayment month",
        loanInst2Month: "2nd repayment month",
        loanConfirmBtn: "Book to Incomes & Expenses",
        loanSuccessAlert: "Loan booked! {{inAmount}} recorded as income in {{inMonth}}, and repayments of {{a1}} in {{m1}} and {{a2}} in {{m2}} scheduled.",
        breakdownTitle: "Receipt Breakdown for {{month}} {{year}}",
        breakdownIncomes: "All Incomes This Month (Total: {{total}}):",
        breakdownExpenses: "All Expenses This Month (Total: {{total}}):",
        breakdownNetResult: "Result (Actual Net = Incomes minus Expenses):",
        noItemsInBreakdown: "No transactions recorded.",
        closeBtn: "Close",
        deleteItemTitle: "Delete Entry: {{name}}",
        deleteFutureOnly: "Clear future months only",
        deleteFutureOnlyDesc: "Past and current month records remain intact.",
        deletePurgeMerge: "Delete completely & move to '{{fallback}}'",
        deletePurgeMergeDesc: "No loss of balance. All amounts and notes are preserved.",
        deleteFallbackBlocked: "\"{{name}}\" is the catch-all category and can't be merged into itself.",
        cancelBtn: "Cancel",
        duplicateAlert: "Category already exists: \"{{name}}\" ({{bracket}})",
        hideWhenZeroHint: "Hide in months without activity",
        fallbackCategory: "Other",
        brackets: {
          housing: "Housing & Fixed Costs",
          subscriptions: "Subscriptions & Media",
          living: "Daily Living & Groceries",
          professional: "Education & Health",
          leisure: "Leisure & Culture",
          other: "Other & Loans",
          fixed_in: "Fixed Income / Blocked Account",
          variable_in: "Variable Income & Loans"
        },
        months: MONTH_NAMES.en
      },
      ar: {
        title: "Jdeeds' Household",
        subtitle: "التدفق النقدي والحسابات الشخصية",
        startingCapital: "الرصيد الافتتاحي (الحساب والنقد)",
        startingMonthLabel: "الرصيد في بداية",
        startingHint: "رصيدك الحقيقي في بداية أول شهر تُسجَّل منه كل المداخيل والمصاريف. الأشهر الأقدم لا تُحسب.",
        beforeStart: "قبل شهر البداية",
        backCalcNote: "محسوب رجوعًا من الرصيد الحقيقي المُدخل في {{month}}",
        kpiActualNet: "الصافي الفعلي (فائض الشهر)",
        kpiActualNetDesc: "اضغط لرؤية التفاصيل",
        kpiProjectedNet: "الصافي المتوقع",
        kpiDailyRoom: "المصروف اليومي",
        kpiCumulative: "الرصيد النهائي",
        kpiCumulativeSub: "الرصيد آخر الشهر",
        kpiDailyRoomSub: "الميزانية اليومية المتاحة",
        endOfMonthTitle: "الرصيد المتوقع آخر {{month}}",
        endOfMonthTitlePast: "الرصيد آخر {{month}}",
        carriedOver: "المُرحَّل من {{month}}",
        carriedStart: "الرصيد الافتتاحي",
        lineIncome: "المداخيل",
        lineFixed: "المصاريف الثابتة",
        lineFlex: "المتغيرة والمرة الواحدة",
        receivedOf: "وصل {{done}} من {{total}}",
        paidOf: "دُفع {{done}} من {{total}}",
        paidCount: "دُفع {{n}} من {{m}} بنود",
        spentOf: "صُرف {{done}} · الهدف {{total}}",
        targetLeft: "بقي {{amount}} من الهدف",
        targetOver: "تجاوز الهدف بـ {{amount}}",
        stillOpen: "بقي للدفع: {{amount}}",
        stillExpected: "ما زال متوقعًا: {{amount}}",
        expectedRules: "طريقة الحساب: المداخيل = ما وصل، وإلا المخطط · الثابتة والمرة الواحدة = ما دُفع، وإلا المخطط · المجموعات المتغيرة = الهدف الشهري، أو أكثر إن تجاوزته. الأشهر المنتهية: فقط ما دخل وخرج فعلًا.",
        thisMonth: "هذا الشهر",
        breakdownBtn: "كل المبالغ",
        fixBalanceBtn: "تصحيح بالرصيد الحقيقي",
        fixBalanceTitle: "أدخل رصيدك الحقيقي",
        fixBalanceTodayLabel: "الرصيد اليوم (الحساب + النقد)",
        fixBalanceStartLabel: "الرصيد في بداية {{month}} (الحساب + النقد)",
        fixBalanceTodayDesc: "يُحسب المبلغ المُرحَّل من هذا الرقم ومما سُجّل في {{month}} (وصل {{in}}، صُرف {{out}})، لذا سجّل أولًا كل ما حدث هذا الشهر. الأشهر الأقدم لا تُحسب بعدها.",
        fixBalanceStartDesc: "يبدأ الحساب من هذا المبلغ في {{month}}. الأشهر الأقدم لا تُحسب بعدها.",
        fixBalancePreview: "المُرحَّل يصبح: {{amount}}",
        fixBalanceSave: "تطبيق",
        groups: {
          transport: "المواصلات",
          health: "الصحة والرياضة",
          education: "التعليم والامتحانات",
          fees: "البنوك والرسوم",
          family: "العائلة والأصدقاء",
          kids: "الأطفال",
          housing: "السكن",
          bills: "الفواتير والاتصالات",
          subs: "الاشتراكات",
          insurance: "التأمين",
          groceries: "البقالة والصيدلية",
          household: "المنزل",
          clothing: "ملابس وأحذية",
          leisure: "الترفيه والأكل خارجًا",
          oneoff: "مرة واحدة"
        },
        filterAll: "الكل",
        filterFixed: "ثابت",
        filterVariable: "متغير ومرة واحدة",
        moreTab: "نظرة عامة",
        groupLabel: "المجموعة",
        groupPaidSub: "دُفع {{n}} من {{m}} · بقي {{amount}}",
        groupAllPaid: "كله مدفوع",
        groupNothingPlanned: "لا شيء مخطط",
        groupTargetSub: "من {{target}} · بقي {{left}}",
        groupOverSub: "تجاوز هدف {{target}} بـ {{amount}}",
        groupNoTarget: "لا يوجد هدف شهري بعد",
        monthlyTarget: "الهدف الشهري",
        monthlyTargetHint: "يسري من {{month}} فصاعدًا",
        itemsCount: "{{n}} بنود",
        dueOn: "مستحق يوم {{day}}",
        notPaidYet: "لم يُدفع بعد",
        receivedLabel: "وصل",
        expectedLabel: "متوقع",
        receiptsCount: "{{n}} إيصالات",
        receiptsOne: "إيصال واحد",
        nothingYet: "لا شيء بعد",
        addReceipt: "إيصال",
        addReceiptTo: "إضافة إيصال إلى {{name}}",
        addBtn: "إضافة",
        receiptAdded: "أُضيف {{amount}} إلى {{name}} · {{group}}: {{spent}} من {{target}}",
        receiptAddedNoTarget: "أُضيف {{amount}} إلى {{name}} · {{group}}: {{spent}}",
        receiptSheetTitle: "إضافة إيصال",
        receiptWhere: "أين صرفته؟",
        receiptNeedAmount: "أدخل المبلغ أولًا، ثم اختر أين صرفته.",
        receiptNoItems: "أضف أولًا بندًا إلى مجموعة متغيرة، مثل Netto.",
        spentTotalLabel: "المصروف في {{month}} (الإجمالي)",
        tapCircleHint: "اضغط الدائرة عند الدفع",
        tapPlusHint: "اضغط + لإضافة إيصال",
        addItemShort: "+ بند",
        newGroup: "+ مجموعة جديدة",
        groupDialogNew: "مجموعة جديدة",
        groupDialogEdit: "تعديل المجموعة",
        groupNameLabel: "الاسم",
        groupNamePlaceholder: "مثلًا: سيارة، حيوان أليف، ادخار",
        groupKindLabel: "النوع",
        groupColorLabel: "اللون",
        groupKindHelp_fixed: "مبالغ معروفة تؤشر عليها عند الدفع: الإيجار، الاشتراكات، الفواتير.",
        groupKindHelp_variable: "اجمع الإيصالات مقابل هدف شهري واحد للمجموعة كلها: البقالة، الصيدلية.",
        groupKindHelp_oneoff: "دفعات منفردة في شهر محدد: رسوم امتحان، تأمين إيجار.",
        groupDelete: "حذف المجموعة",
        groupDeleteMove: "انقل بنودها الـ {{n}} إلى:",
        groupSave: "حفظ",
        actPeriod: "الفترة",
        actEdit: "تعديل",
        markReceivedAria: "تأشير {{name}} كواصل",
        markPaidAria: "تأشير {{name}} كمدفوع",
        groupFixed: "مصاريف ثابتة · إيجار، فواتير، اشتراكات",
        groupFlex: "متغيرة ومرة واحدة",
        targetLabel: "الهدف",
        spentLabel: "المصروف",
        paidLabel: "المدفوع",
        markPaid: "مدفوع",
        markReceived: "واصل",
        markPaidHint: "سجّل المبلغ المخطط كمدفوع",
        markReceivedHint: "سجّل المبلغ المخطط كواصل",
        kpiIn: "دخل",
        kpiOut: "خرج",
        kpiProjPrefix: "متوقع:",
        incomesHeader: "المداخيل",
        expensesHeader: "المصاريف",
        analyticsTab: "نظرة عامة وديون",
        planLabel: "المخطط",
        actualLabel: "الفعلي",
        asOfDayLabel: "اليوم",
        asOfDayHint: "يوم الشهر الذي يُحسب الفعلي حتى تاريخه. فارغ = تلقائي (اليوم).",
        restBudgetLabel: "المتبقي",
        perDayLabel: "/ يوم",
        statusOver: "فوق الميزانية",
        statusTrack: "ضمن الخطة",
        statusFrugal: "تحت الميزانية",
        badgeOneTime: "مرة واحدة",
        badgeFixed: "ثابت",
        badgeVariable: "متغير",
        modeLabel: "النوع",
        options: "الإعدادات",
        themeLabel: "المظهر",
        themeLight: "فاتح",
        themeDark: "داكن",
        themeSystem: "حسب الجهاز",
        cloudSync: "المزامنة السحابية",
        signIn: "تسجيل الدخول بـ Google",
        signOut: "تسجيل الخروج",
        signedInAs: "مسجّل باسم {{email}}",
        signInError: "فشل تسجيل الدخول: {{msg}}",
        syncLocalOnly: "محفوظ على هذا الجهاز فقط. سجّل الدخول للمزامنة بين الأجهزة.",
        syncStatus_local: "محلي فقط",
        syncStatus_pending: "جارٍ الحفظ…",
        syncStatus_synced: "متزامن",
        syncStatus_error: "خطأ في المزامنة – البيانات محفوظة محليًا",
        backupSection: "البيانات والتخزين",
        exportBackup: "تصدير JSON",
        importBackup: "استعادة JSON",
        importSuccess: "تمت استعادة البيانات بنجاح!",
        importError: "صيغة الملف تالفة.",
        clearAll: "حذف كل البيانات",
        confirmClear: "هل تريد فعلًا حذف كل البيانات نهائيًا؟",
        showAllBtn: "إظهار بنود 0 €",
        hideZeroesBtn: "إخفاء بنود 0 €",
        showZeroTitle: "إظهار بنود 0 €",
        hideZeroTitle: "إخفاء بنود 0 €",
        hiddenNoticeBracket: "{{count}} بنود غير نشطة (0 €) مخفية",
        showNow: "إظهار",
        expandAll: "فتح الكل",
        collapseAll: "طي الكل",
        annualOverview: "العرض السنوي",
        annualRunway: "التدفق السنوي",
        annualSavingsRate: "نسبة الادخار (متوقعة)",
        annualMonth: "الشهر",
        annualNet: "الصافي الفعلي",
        annualProjected: "المتوقع",
        annualBalance: "الرصيد",
        annualTotal: "المجموع",
        iouTitle: "الديون والمستحقات",
        iouAddBtn: "إضافة",
        iouPersonPlaceholder: "مثلًا: الأخت (دين 900 €)...",
        iouAmountPlaceholder: "المبلغ",
        iouOptBorrowed: "عليّ (دين/قرض)",
        iouOptLent: "لي (أقرضت)",
        iouDebts: "ديون:",
        iouReceivables: "مستحقات:",
        iouSisterTip: "استلفت مالًا من أختك (900 €)؟",
        iouSisterHint: "يضيف +{{amount}} كدخل في {{month}} ويجدول دفعتين بقيمة {{half}} في {{m1}} و{{m2}}.",
        iouSisterBtn: "⚡ تسجيل الدين المستلم وجدولة السداد",
        iouIOweBadge: "عليّ",
        iouOwedToMeBadge: "لي",
        iouMarkReturned: "تأشير كمُسدَّد",
        iouLoanLink: "تسجيل دين وجدولة السداد",
        iouDelete: "حذف (أُدخل بالخطأ)",
        iouDeleteConfirm: "حذف \"{{person}} · {{amount}}\"؟ هذا يزيله من قائمة الديون فقط، لا من المداخيل ولا من دفعات السداد.",
        loanDuplicateWarn: "سجّلت مسبقًا دينًا بقيمة {{amount}} ({{person}}، {{date}}). تسجيله مرة أخرى يحسب الدخل والسداد والدين مرتين.",
        emptyGroupIncomes: "لا مداخيل نشطة هذا الشهر.",
        emptyGroupExpenses: "لا مصاريف في هذه المجموعة هذا الشهر.",
        editorTitle: "تعديل البند",
        posten: "اسم البند",
        bracketLabel: "الفئة",
        paymentDayShort: "يوم الدفع",
        deleteCategoryBtn: "حذف",
        saveClose: "حفظ وإغلاق",
        addItemBtn: "+ بند جديد",
        notesTitleMonth: "ملاحظات وإيصالات ({{month}} {{year}})",
        addNotePlaceholder: "أضف ملاحظة أو بندًا...",
        quickAddModalTitle: "إضافة بند جديد",
        quickAddNamePlaceholder: "مثلًا: سداد الأخت، Netflix...",
        initialBudgetLabel: "المبلغ المخطط (€)",
        isOneTimeCurrentOnly: "فقط في شهر \"من\" (0 € في باقي الأشهر)",
        rangeFrom: "من",
        rangeUntil: "حتى",
        rangeSummary: "{{n}} أشهر: {{from}} – {{until}}",
        rangeSummaryOne: "شهر واحد: {{from}}",
        repeatLabel: "التكرار",
        repeat1: "كل شهر",
        repeat2: "كل شهرين",
        repeat3: "كل 3 أشهر (فصليًا)",
        repeat6: "كل 6 أشهر",
        repeat12: "مرة في السنة",
        paymentsSummary: "{{n}} دفعات: {{list}}",
        quickStores: "إضافة سريعة:",
        importTitle: "استيراد كشف حساب",
        importBtn: "⬇ استيراد",
        importAccount: "أي حساب؟",
        importOwn: "حساب {{name}}",
        importJoint: "الحساب المشترك",
        importFrom: "فقط القيود من تاريخ",
        importFromHint: "الأشهر التي أدخلتها يدويًا ستُحسب مرتين لولا ذلك.",
        importChoose: "اختر ملفًا (CSV أو Excel أو PDF)",
        importHowTo: "Revolut: افتح الحساب ← \"…\" ← كشف حساب ← CSV أو Excel (الكشف الموحّد لكل الحسابات يعمل أيضًا). Wise: الحساب ← كشوف الحساب ← CSV. Sparkasse وVolksbank وغيرها: كشف الحساب PDF من الخدمات المصرفية عبر الإنترنت أو ملف الحركات CSV. ملف Money Manager (Excel) يعمل أيضًا.",
        importBadFile: "تعذّرت قراءة هذا الملف. يجب أن يكون كشف حساب (CSV أو Excel أو PDF) فيه تاريخ ووصف ومبلغ.",
        importSummary: "{{file}}: {{n}} سطرًا · {{ready}} مطابق · {{dup}} مستورد مسبقًا · {{skipped}} متجاوز",
        importSelectAll: "تحديد كل ما له اقتراح",
        importSelectNone: "إلغاء التحديد",
        importSkipOption: "— لا تستورد —",
        importNewItem: "جديد: {{name}}",
        importNothingNew: "لا قيود جديدة في هذا الملف.",
        importSkippedList: "إظهار {{n}} أسطر متجاوزة",
        importSkip_dup: "مستورد مسبقًا",
        importSkip_state: "غير مكتمل",
        importSkip_currency: "عملة أخرى",
        importSkip_range: "خارج أيار 2026 – كانون الأول 2028",
        importSkip_before: "قبل التاريخ المختار",
        importSkip_exchange: "تحويل عملة",
        importSkip_future: "في المستقبل (يبقى مخططًا)",
        importSkip_entered: "مُدخل يدويًا مسبقًا (نفس اليوم والمبلغ)",
        importTotals: "المحدد: + {{inSum}} دخل · − {{outSum}} خرج · الصافي {{net}}",
        importThenBalance: "الآن استخدم \"تصحيح بالرصيد الحقيقي\"",
        importRun: "استيراد {{n}} قيود",
        importDone: "تم استيراد {{n}} قيود",
        importOwnTransfer: "تحويل بين حساباتك",
        importReplacesTick: "يحل محل تأشيرك",
        importTransfersNote: "وُجد {{n}} تحويلات بين حساباتك. ليست دخلًا ولا مصروفًا، لذا تبقى غير محددة.",
        dueTitle: "مستحق قريبًا",
        dueOverdue: "متأخر منذ {{day}} {{month}}",
        dueOnDay: "مستحق {{day}} {{month}}",
        dueInMonth: "في {{month}}",
        dueMore: "+ إظهار {{n}} أخرى",
        dueLess: "إظهار أقل",
        dueThis: "هذا الشهر",
        dueNext: "القادم",
        dueBoth: "كلاهما",
        dueNothing: "كله مدفوع 🎉",
        dueNoDay: "بلا يوم محدد",
        forecastTitle: "التوقعات: الرصيد آخر كل شهر (12 شهرًا)",
        incomeEndTitle: "مداخيل ستنتهي",
        incomeEndLast: "آخر دفعة: {{when}}",
        incomeEndFrom: "تنقص من {{month}}",
        incomeEndTotal: "من {{month}} ينقص المجموع {{amount}} شهريًا.",
        incomeEndHint: "خطّط مبكرًا لتعويضها: احتياطي، مصاريف أقل أو دخل جديد. الخط الأحمر في التوقعات يبيّن متى تتوقف.",
        forecastLow: "أدنى نقطة: {{amount}} آخر {{month}}",
        forecastNegative: "انتبه: آخر {{month}} ستكون عند {{amount}}",
        setAsideTitle: "للتجنيب",
        setAsideHint: "دفعات غير منتظمة أو قادمة لمرة واحدة، موزعة على الأشهر. جنّب هذا المبلغ كل شهر فلا تفاجئك.",
        setAsideRhythm: "{{n}}× في 12 شهرًا · القادمة {{month}}",
        setAsideOnce: "مرة في {{month}}",
        perMonthShort: "{{amount}}/شهريًا",
        goalsTitle: "أهداف الادخار",
        goalNew: "+ هدف",
        goalNewTitle: "هدف ادخار جديد",
        goalEdit: "تعديل هدف الادخار",
        goalsEmpty: "لا أهداف ادخار بعد، مثل احتياطي طوارئ أو هاتف أو عطلة.",
        goalNamePlaceholder: "مثلًا: احتياطي طوارئ",
        goalTarget: "الهدف",
        goalSaved: "المدّخر حتى الآن",
        goalDeadline: "حتى متى؟",
        goalNoDeadline: "بلا موعد",
        goalHint: "أهداف الادخار لا تُحسب في ميزانية الشهر، بل تتابع فقط ما جنّبته.",
        goalReached: "تحقق الهدف 🎉",
        goalPerMonth: "{{amount}}/شهريًا حتى {{month}}",
        goalLeft: "بقي {{amount}}",
        goalDeposit: "+ إضافة ادخار",
        goalDeposited: "ادُّخر {{amount}} لـ \"{{name}}\"",
        goalDeleteConfirm: "حذف هدف الادخار \"{{name}}\"؟",
        iouRepaid: "سُدّد {{repaid}} من {{total}} (عبر \"{{item}}\")",
        iouLinkRepay: "اربط السداد بـ …",
        reportGroups: "المصاريف حسب المجموعة {{year}}",
        reportAvgNote: "المتوسط على {{n}} أشهر فيها مصاريف.",
        reportTopItems: "أكبر البنود",
        reportWhoNote: "من القيود المفردة (الإيصالات والاستيراد).",
        membersLabel: "أفراد المنزل (الأسماء)",
        autoBackups: "نسخ احتياطية تلقائية (هذا الجهاز)",
        autoBackupsEmpty: "لا شيء بعد. من تغييرك القادم تُحفظ نسخة واحدة يوميًا.",
        autoBackupsHint: "نسخة واحدة يوميًا لآخر 14 يومًا. يمكن التراجع عن الاستعادة.",
        autoBackupRestore: "استعادة",
        autoBackupConfirm: "استعادة الحالة من {{day}}؟ كل ما بعدها سيُستبدل.",
        autoBackupRestored: "تمت استعادة النسخة",
        beforePaydayTitle: "المتبقي حتى الراتب القادم · {{month}}",
        beforePaydayLine: "قبل الراتب القادم",
        carriedBeforeSalary: "المتبقي قبل راتب {{month}}",
        linePaidEndPrev: "دُفع آخر {{month}} (لهذا الشهر)",
        leavingForNext: "يخرج آخر {{month}} لـ {{next}}",
        forNextExpLabel: "يُدفع من الراتب القادم",
        forNextExpHelp: "يُدفع فقط بعد الراتب آخر الشهر (مثل الإيجار يوم 28)، لذا يُحسب في الشهر التالي. أدخله في شهر الدفع.",
        lineIncomeFromPrev: "راتب {{month}} (لهذا الشهر)",
        lineIncomeThis: "مداخيل أخرى في {{month}}",
        arrivingForNext: "يصل آخر {{month}} لـ {{next}}",
        availableNow: "في الحسابات الآن (حسب القيود)",
        forNextBadge: "← لـ {{month}}",
        forNextLabel: "للشهر القادم",
        forNextHelp: "يصل آخر الشهر (مثل يوم 26) ويُصرف في الشهر التالي. أدخله في شهر وصوله، ويُحسب في التالي.",
        shiftTip: "هل يصل راتبك آخر الشهر؟ افتحه في المداخيل ← ✎ تعديل ← \"للشهر القادم\".",
        paydayLabel: "يصل الراتب يوم",
        paydayOff: "بلا يوم محدد (شهر تقويمي)",
        paydayOption: "يوم {{day}} (شهر الميزانية: {{day}} حتى {{until}})",
        paydayHelp: "يبدأ شهر ميزانيتك مع الراتب.",
        forNextAuto: "يُحسب تلقائيًا للشهر التالي (يوم الدفع {{day}} ≥ يوم الراتب {{payday}})",
        countsForNext: "يُحسب لـ {{month}}",
        whoJoint: "مشترك",
        whoLabel: "من دفع؟",
        whoPaidTitle: "من دفع؟ (المصاريف)",
        noteLabel: "ملاحظة (اختياري)",
        dateLabel: "التاريخ",
        undoBtn: "تراجع",
        txDeleted: "حُذف {{amount}} من {{name}}",
        entriesLabel: "القيود ({{n}})",
        txBtn: "القيود",
        navOverview: "نظرة عامة",
        navMonth: "الشهر",
        navActivity: "النشاط",
        navPlan: "التخطيط",
        navMore: "المزيد",
        prevMonth: "الشهر السابق",
        nextMonth: "الشهر التالي",
        todayBtn: "اليوم",
        dismiss: "إخفاء",
        heroIn: "دخل",
        heroOut: "خرج",
        heroStart: "البداية",
        heroDetails: "إظهار الحساب",
        heroHide: "إخفاء الحساب",
        howCalc: "كيف يُحسب هذا؟",
        quickReceipt: "إيصال",
        quickImport: "استيراد",
        quickAsk: "اسأل",
        quickHistory: "السجل",
        incomeEndShort: "{{n}} مداخيل ستنتهي · من {{month}} ينقص {{amount}}",
        showDetails: "التفاصيل",
        hideDetails: "أقل",
        emptyItems: "{{n}} بلا مبلغ",
        hideEmpty: "إخفاء الفارغة",
        emptyGroups: "لا شيء هذا الشهر ({{n}})",
        actEntries: "الإيصالات",
        actHistory: "السجل",
        actSummary: "ملخص الشهر",
        planYear: "السنة",
        planOutlook: "التوقعات",
        accountsTitle: "الحسابات",
        accountsIntro: "أدخل أرصدتك الحقيقية من حين لآخر، والتطبيق يقارنها بأرقامه.",
        accountsSetup: "إضافة حساباتنا",
        accountAdd: "+ حساب",
        accountMain: "الحسابات الرئيسية",
        accountGateway: "حسابات العبور",
        accountCash: "النقد",
        accountsTotal: "المجموع",
        accountsAppNow: "حسب التطبيق الآن",
        accountsDiff: "الفرق",
        accountsUse: "اعتماده كرصيد حقيقي",
        accountsUsed: "اعتُمد الرصيد: {{amount}}",
        accountsUpdated: "فُحص {{day}}",
        accountName: "الاسم",
        accountsMatch: "مطابق ✓",
        accountRemoved: "حُذف الحساب",
        entrySaved: "حُفظ الإدخال",
        entryTitle: "تعديل الإدخال",
        itemFromBank: "البنك",
        itemGroupOf: "{{group}}: {{spent}} من {{target}}",
        itemOfPlan: "من {{plan}} مخطط",
        itemNoPlan: "لا خطة لهذا الشهر",
        itemAdd: "تسجيل",
        itemPaid: "مدفوع",
        itemReceived: "مستلم",
        itemMarkPaid: "تعليم كمدفوع",
        itemMarkReceived: "تعليم كمستلم",
        itemSettings: "الإعدادات",
        itemEntries: "إدخالات هذا الشهر ({{n}})",
        itemNoEntries: "لا شيء مسجل بعد.",
        edPlanCard: "الخطة والتكرار",
        stillIn: "ما زال سيدخل هذا الشهر",
        stillOut: "ما زال سيخرج هذا الشهر",
        accountSavings: "حسابات الادخار",
        savingsOutItem: "ادخار",
        savingsInItem: "من الادخار",
        savingsHint: "المال في حسابات الادخار لا يُحسب قابلًا للصرف. انقل المال إليها أو منها عبر إضافة ← تحويل.",
        fixTitle: "{{n}} من إدخالاتك موجودة أيضًا في هذا الكشف",
        fixHint: "من دفع وأي حساب، كما في الكشف. أزل العلامة عمّا يجب أن يبقى كما هو.",
        fixBtn: "تصحيح {{n}} إدخالات",
        fixDone: "صُحّحت {{n}} إدخالات",
        labsTitle: "ميزات جديدة (يمكن إيقاف كل واحدة)",
        labsNowToday: "„الآن“ بدون إدخالات بعد اليوم",
        labsReminders: "تذكير بالفواتير المستحقة",
        labsImportAmount: "الاستيراد يتعرف على الفواتير بالمبلغ",
        labsCloseMonth: "بطاقة إغلاق الشهر",
        labsSplitUp: "من دفع ماذا",
        srchTitle: "بحث",
        srchPh: "محل أو بند أو ملاحظة أو مبلغ – مثل Action",
        srchAll: "كل السنوات",
        srchFound: "{{n}} إدخالات",
        srchHint: "اكتب حرفين على الأقل.",
        cmTitle: "إغلاق {{month}}",
        cmSub: "بقي {{n}} أيام",
        cmStepAccounts: "أدخل أرصدة الحسابات (ليكون „الآن“ صحيحًا).",
        cmOpenAccounts: "افتح الحسابات",
        cmStepBillsOpen: "{{n}} فواتير لم تُدفع بعد ({{amount}}).",
        cmStepBillsDone: "كل الفواتير مدفوعة.",
        cmStepLeftover: "المتبقي في ميزانيات التسوق: {{amount}}",
        cmToGoal: "ضع {{amount}} في هدف الادخار",
        cmNoGoal: "أنشئ هدف ادخار في „التخطيط“ لتضع الباقي فيه.",
        suTitle: "من دفع ماذا",
        suEven: "دفعتما تقريبًا نفس المبلغ هذا الشهر.",
        suOwes: "{{who}} يعطي {{to}} {{amount}} فتصبحان متعادلين.",
        suHint: "فقط الإدخالات التي فيها „من؟“ – المصاريف المشتركة لا تُحسب.",
        remTitle: "تذكيرات ({{n}})",
        remAllow: "فعّل إشعارات الهاتف",
        rem_overdue: "متأخرة",
        rem_today: "تستحق اليوم",
        rem_tomorrow: "تستحق غدًا",
        rem_late: "لم يصل بعد",
        acctSince: "منذ {{day}}: {{n}} إدخالات، {{delta}}",
        acctExpected: "← اعتمد {{amount}}",
        futureNote: "مسجّل لما بعد اليوم – ليس في البنك بعد",
        loanDupSpare: "مكرر – يمكن حذف هذه النسخة",
        loanSettledList: "القروض المسوّاة ({{n}})",
        loanPaidVia: "سُدد عبر „{{item}}“: {{amount}}",
        loanNoLink: "بدون بند سداد",
        loanDup: "مكرر؟",
        loanReopen: "إعادة فتح",
        loanSettledToast: "تمت تسوية القرض – أُزيلت الأقساط المخططة غير المدفوعة",
        pmToggle: "مختلف كل شهر",
        pmDefault: "مبلغ الأشهر التي ليس لها قيمة خاصة (€)",
        pmList: "{{n}} أشهر · المجموع {{total}}",
        pmUsePaid: "استخدم المبالغ المدفوعة ({{n}})",
        pmHint: "غيّر أي شهر وحده. ✓ = دُفع في ذلك الشهر.",
        kWhatKind: "ما نوعه؟",
        kPurchase: "شراء",
        kBill: "فاتورة شهرية",
        kSub: "اشتراك",
        kOnebill: "فاتورة لمرة واحدة",
        kOneoffIn: "لمرة واحدة",
        kRegularIn: "منتظم",
        kEvery: "كل",
        kMonth1: "شهر",
        kMonthsN: "{{n}} أشهر",
        kOnDay: "تستحق يوم",
        kOnDayIn: "يصل يوم",
        kDueOn: "تستحق في {{date}} (غيّر التاريخ في الأسفل)",
        kPaidNow: "مدفوعة بالفعل (سجّلها الآن)",
        kReceivedNow: "تم الاستلام (سجّله الآن)",
        kHintRepeatPaid: "تُخطط كل {{every}} بدءًا من هذا الشهر، وتُسجّل هذه الدفعة.",
        kHintRepeatLater: "تُخطط فقط – تظهر في „مستحق قريبًا“ حتى تؤشر عليها.",
        kHintOnebillPaid: "تُخطط مرة واحدة وتُسجّل كمدفوعة فورًا.",
        kHintOnebillLater: "تُخطط مرة واحدة – تظهر في „مستحق قريبًا“ وفي التقويم.",
        kBillCard: "{{month}}: {{plan}} مخطط",
        kDueDay: "تستحق يوم {{d}}",
        kAlreadyPaid: "مدفوعة بالفعل ({{amount}}) – التسجيل مرة أخرى يُحسب مرتين.",
        kPartPaid: "دُفع حتى الآن {{amount}}.",
        bkPlanned: "„{{name}}“ مُخطط – لم يُدفع شيء بعد.",
        selStart: "تحديد",
        selDone: "تم",
        selMonth: "هذا الشهر ({{n}})",
        selAllMonths: "كل الأشهر ({{n}})",
        selNotPlan: "الكل عدا {{amount}} ({{n}})",
        selNone: "لا شيء",
        moveTo: "انقل إلى … (اختر بندًا أو اكتب جديدًا)",
        moveBtn: "نقل {{n}}",
        moveNew: "سيُنشأ بند جديد „{{name}}“.",
        movedToast: "{{n}} إدخالات ← {{to}}",
        entryItemSettings: "تعديل البند",
        entryCreate: "إنشاء „{{name}}“",
        entryMoveAll: "انقل أيضًا الإدخالات الـ{{n}} الأخرى بقيمة {{amount}} من „{{from}}“ (مثل الأشهر السابقة)",
        motionLabel: "الحركة والتأثيرات",
        motionOn: "تشغيل",
        motionOff: "إيقاف",
        shopAllItems: "كل البنود …",
        shopNewItem: "بند جديد",
        shopWhat: "ماذا اشتريت من {{shop}}؟",
        shopKeep: "أو لا تختر شيئًا – فيبقى تحت „{{shop}}“.",
        shopBoughtAt: "اشتُري من {{shop}} ← {{item}}",
        splitBtn: "تقسيم على عدة بنود",
        splitTitle: "تقسيم",
        splitCancel: "بدون تقسيم",
        splitRest: "الباقي",
        splitAdd: "بند آخر",
        splitTooMuch: "مجموع الأجزاء يساوي المبلغ أو أكثر – لا يبقى شيء للبند الأول.",
        logoSearch: "ابحث عن شعار – مثل DB أو Rewe أو Vodafone",
        logoNone: "لا يوجد شعار – اختر رمزًا من الأسفل.",
        mergedToast: "„{{from}}“ أصبح جزءًا من „{{to}}“",
        dcSame: "„{{a}}“ و„{{b}}“ يبدوان الشيء نفسه.",
        dcMergeInto: "دمج في „{{name}}“",
        mergeLabel: "دمج مع",
        mergePick: "اختر بندًا …",
        mergeConfirm: "نقل كل الإدخالات والخطط والملاحظات من „{{from}}“ إلى „{{to}}“ وحذف „{{from}}“؟",
        schNow: "حاليًا:",
        schFrom: "من {{month}}",
        schFirst: "الدفعة الأولى {{amount}}",
        schEveryMonth: "ثم {{amount}} كل شهر",
        schEveryN: "ثم {{amount}} كل {{n}} أشهر",
        schOpenEnd: "بلا نهاية",
        schUntil: "حتى {{month}}",
        schOdd: "{{n}} شهر بمبلغ مختلف – يبقى كما هو ما لم تغيّر شيئًا هنا.",
        schFirstToggle: "الدفعة الأولى مختلفة",
        schFirstLabel: "الدفعة الأولى (€)",
        schThenLabel: "بعدها كل مرة (€)",
        calNothingDay: "لا مدفوعات في هذا اليوم",
        otAdd: "التسجيل عبر «تسجيل»",
        calKind_earlier: "مُدخل سابقًا",
        calKind_loan: "دين",
        calLegShops: "المحلات والمجموعات",
        calLegTap: "نقرتان = عرض اليوم",
        tipsTitle: "اقتراحات الذكاء الاصطناعي",
        tipsSub: "نصائح شخصية لهذا الشهر",
        tipsFrom: "بتاريخ {{when}}",
        tipsGet: "احصل على اقتراحات",
        tipsRefresh: "تحديث",
        tipsIntro: "يطّلع الذكاء الاصطناعي على شهركم الحالي (الأهداف والفواتير والرصيد ونسبة الادخار) ويعطي 3–5 نصائح قصيرة وعملية. فقط عند الضغط – كل طلب يكلّف بضعة سنتات من رصيد API.",
        tipsOtherLang: "هذه النصائح بلغة أخرى – «تحديث» يجلبها باللغة الحالية.",
        calModeMonth: "شهر",
        calModeDay: "يوم",
        calLegGroups: "اللون = المجموعة",
        edTabDetails: "التفاصيل",
        edTabPeriod: "المبالغ والفترة",
        actEditAll: "تعديل",
        starterBtn: "الحزمة الأساسية للعائلة",
        starterDone: "أُضيفت الحزمة الأساسية: الدخل والفواتير والأطفال والمحلات",
        starterHint: "تضيف الدخل المعتاد (حسابان مجمّدان، Kindergeld) والفواتير وبنود الأطفال والمحلات – فقط ما ينقص.",
        rcPhoto: "تصوير الفاتورة",
        rcHint: "نصيحة: 📷 صوّر الفاتورة – يملأ الذكاء الاصطناعي المحل والمبلغ والتاريخ.",
        rcBusy: "جارٍ قراءة الفاتورة …",
        rcNone: "لم يمكن قراءة مبلغ من الصورة.",
        rcRead: "قُرئ: {{amount}} · {{shop}} – تحقق ثم احفظ",
        ovArrange: "ترتيب البطاقات",
        ovArrangeHint: "غيّر ترتيب البطاقات في النظرة العامة أو أخفِ بعضها (العين). يُحفظ على هذا الجهاز.",
        ovToggle: "إظهار/إخفاء",
        ovReset: "إعادة الضبط",
        ovDone: "تم",
        ovN_review: "مراجعة الشهر",
        rvTitle: "مراجعة {{month}}",
        rvSubPlus: "دخل {{amount}} أكثر مما صُرف",
        rvSubMinus: "صُرف {{amount}} أكثر مما دخل",
        rvDone: "تم",
        rvIn: "دخل",
        rvOut: "صُرف",
        rvNet: "النتيجة",
        rvPlanned: "مخطط",
        rvSurprises: "أكثر من المخطط:",
        rvBiggest: "أكبر البنود:",
        rvCheckBal: "تحقق من الأرصدة",
        rvHint: "نظرة سريعة في بداية كل شهر: إن كانت الأرصدة صحيحة يبدأ الشهر الجديد بأرقام صحيحة.",
        bkTransfer: "تحويل",
        trFrom: "من حساب",
        trTo: "إلى حساب",
        trMove: "تعديل أرصدة الحسابات",
        trMoveHint: "يخصم المبلغ من حساب ويضيفه إلى الآخر. لا يُحسب أبدًا كدخل أو مصروف.",
        trNeedAccounts: "اختر حسابين مختلفين.",
        trSaved: "حُوّل {{amount}}: {{from}} ← {{to}}",
        trDeleted: "حُذف التحويل",
        calKind_transfer: "تحويل",
        dcTitle: "فحص البيانات",
        dcSub: "{{n}} أمور تقلل دقة الأرقام",
        dcUndated: "{{n}} فواتير بلا يوم استحقاق – اضغط على واحدة لتحديده:",
        dcGap: "حساباتكم تُظهر {{real}} والإدخالات {{app}} – بفرق {{diff}}. هناك شيء ناقص أو مكرر.",
        dcUseReal: "اعتماد الرصيد الحقيقي",
        dcCheckAccounts: "عرض الحسابات",
        dcDupLoan: "\"{{person}}\" · {{amount}} مسجّل {{n}} مرات كدين – ربما مكرر؟",
        dcReview: "مراجعة",
        dcLoanMoney: "{{n}} ديون قديمة لم تُفحص في الرصيد بعد.",
        dcNoDate: "{{n}} مشتريات هذا الشهر بلا يوم ({{amount}})، لذلك لا تظهر في التقويم. اضغط على واحدة واختر يومها واحفظ.",
        dcOpenAdd: "إلى تسجيل",
        bkRepeat: "الأخيرة – اضغط للتكرار",
        bkLeft: "يبقى {{amount}} بعد هذا",
        bkOver: "بهذا تتجاوز الهدف بـ {{amount}}",
        bkNoPlan: "لا هدف محدد لهذا الشهر.",
        bkSearchBig: "ابحث عن محل أو بند – مثل Netto أو Kita أو DHL",
        bkFound: "وُجد {{n}} من بنودك",
        bkOther: "تاريخ آخر",
        bkMoreSugg: "+ {{n}} أخرى",
        bkSuggest: "إنشاء جديد – اضغط للاختيار:",
        calPaid: "مدفوع",
        calGot: "مستلم",
        calStillDue: "مستحق بعد",
        calDue: "مستحق",
        calExpected: "متوقع",
        calKind_receipt: "فاتورة شراء",
        calKind_bill: "فاتورة",
        calKind_spent: "مصروف",
        calKind_income: "دخل",
        calLegPaid: "مدفوع",
        calLegDue: "مستحق بعد",
        calLegIn: "دخل",
        calUndated: "بلا يوم هذا الشهر: {{n}} بنود · {{amount}}",
        calUndatedHint: "هذه البنود بلا يوم استحقاق. حدّد اليوم للبند (أو سجّل المشتريات عبر \"إضافة\") لتظهر في التقويم.",
        navBook: "تسجيل",
        bkOut: "مصروف",
        bkIn: "دخل",
        bkAmount: "المبلغ",
        bkWhere: "على ماذا؟",
        bkWhereIn: "من أين؟",
        bkSearch: "بحث …",
        bkNew: "جديد",
        bkNewName: "الاسم، مثل Rewe",
        bkAll: "عرض الكل ({{n}})",
        bkLess: "عرض أقل",
        bkWhen: "متى؟",
        bkToday: "اليوم",
        bkYesterday: "أمس",
        bkAccount: "الحساب",
        bkNoAccount: "بدون",
        bkWho: "من؟",
        bkNote: "ملاحظة (اختياري)",
        bkSave: "حفظ",
        bkSaved: "حُفظ {{amount}} · {{name}} · {{date}}",
        bkNeedAmount: "أدخل مبلغًا.",
        bkNeedCat: "اختر على ماذا – أو اضغط \"جديد\".",
        bkNeedDate: "هذا التاريخ خارج الخطة.",
        calTitle: "التقويم",
        calTotal: "{{amount}} · {{n}} إدخالات",
        calEmpty: "لا شيء مسجل هذا الشهر بعد – كل ما تضيفه يظهر هنا في يومه.",
        calDayEmpty: "لا شيء مسجل في هذا اليوم.",
        calAddHere: "+ إضافة في هذا اليوم",
        calNote: "كل إدخال يُحسب ضمن بنده في ذلك الشهر (مثل الفاتورة). كلما كان اليوم أغمق، كان الصرف أكثر؛ والنقطة الخضراء تعني دخلًا. المبالغ المكتوبة مباشرة في الشهر بلا تاريخ ولا تظهر في التقويم.",
        abRealBal: "الرصيد الحقيقي (الحسابات، تم التحقق {{date}})",
        abRealDiff: "حسب الإدخالات: {{amount}}. حدّث الأرصدة في المزيد ← الحسابات ليبقى هذا الرقم دقيقًا.",
        abNoReal: "أدخل أرصدتكم الحقيقية في المزيد ← الحسابات لتبدأ هذه البطاقة منها.",
        abNowBal: "الرصيد الآن (حسب الإدخالات)",
        abFitsNow: "ما زال مخططًا للطعام وغيره {{month}} هذا الشهر؛ للأيام {{from}}–{{to}} نحو {{amount}} – وهذا يكفي.",
        abTightNow: "انتبه: ما زال مخططًا للطعام وغيره {{month}}؛ للأيام {{from}}–{{to}} نحو {{amount}} – أكثر من المتاح.",
        abSpendUntil: "للصرف حتى {{day}} {{month}}",
        abSpendMonth: "للصرف هذا الشهر",
        abPerDay: "≈ {{amount}} يوميًا لمدة {{n}} يومًا (من {{from}} إلى {{to}})",
        abNothing: "بعد الفواتير لا يبقى شيء حتى وصول المال التالي.",
        abLowest: "أدنى نقطة ({{day}} {{month}})",
        abLateIn: "يصل من يوم {{day}}",
        abEnd: "آخر {{month}} (قبل المتغيرات)",
        abFits: "أهدافكم للطعام وغيره ({{month}}/شهر) تحتاج نحو {{amount}} للأيام {{from}}–{{to}} – وهذا يكفي.",
        abTight: "انتبه: أهدافكم للطعام وغيره تحتاج نحو {{amount}} للأيام {{from}}–{{to}} – أكثر من المتاح.",
        abUndated2: "بلا تاريخ: {{b}} فواتير تُحسب من اليوم 1 و{{i}} دخل في آخر الشهر فقط، احتياطًا. حدّد يوم الاستحقاق للبند.",
        abHint2: "الخط هو رصيدكم يومًا بيوم بالدخل والفواتير فقط (دون الطعام وغيره). أدنى نقطة من اليوم فصاعدًا هي ما يمكن صرفه على المتغيرات قبل وصول المال التالي دون النزول تحت الصفر. لهذا الشهر تبدأ من رصيدكم الآن (كل ما دخل وصُرف حتى الآن، والطعام ضمنه)، وللشهر القادم من الرصيد المتوقع آخر هذا الشهر.",
        forecastTitleAll: "رصيد آخر الشهر: السابق والقادم",
        forecastNext: "القادم",
        forecastAll: "الكل",
        abTitle: "بعد دفع الفواتير",
        abThis: "هذا",
        abNext: "القادم",
        abOnDay: "المتبقي في {{day}} {{month}}",
        abFree: "الحر بعد كل الفواتير",
        abStart: "الرصيد أول الشهر",
        abIncome: "دخل الشهر",
        abBills: "الفواتير والتكاليف الثابتة",
        abVariable: "أهداف المتغيرات (طعام …)",
        abAfterVariable: "يبقى للادخار",
        abLateIncome: "يصل بعد يوم {{day}}: {{list}}.",
        abShowList: "عرض كل الفواتير ({{n}})",
        abHideList: "إخفاء القائمة",
        abShowList2: "عرض كل الحركات ({{n}})",
        abUndated: "{{n}} فواتير بلا تاريخ محسوبة احتياطًا حتى يوم {{day}}.",
        abHint: "الرصيد أول الشهر = الرصيد المتوقع آخر الشهر السابق. \"المتبقي في يوم {{day}}\" = الرصيد + الدخل الواصل حتى ذلك اليوم − الفواتير المستحقة حتى ذلك اليوم (وتُحسب الفواتير بلا تاريخ). \"الحر\" = الرصيد + كل الدخل − كل فواتير الشهر وتكاليفه الثابتة؛ ومنه تُدفع المصاريف المتغيرة والباقي للادخار. حدّد يوم الاستحقاق لكل بند.",
        noAccessTitle: "لا يوجد منزل لهذا الحساب بعد",
        noAccessText: "{{email}} غير مسموح له بدخول أي منزل بعد. الأسماء الظاهرة مجرد أمثلة. اطلب من المالك إضافة هذا العنوان في قواعد Firebase ثم أعد فتح التطبيق.",
        householdLabel: "المنزل",
        householdUnnamed: "منزل بلا اسم",
        householdNew: "إنشاء منزل جديد",
        hhWelcome: "أهلًا بكم في منزلكم الجديد",
        hhWelcomeText: "هذا المنزل فارغ ومنفصل تمامًا عن غيره. أعطه اسمًا وأدخلوا أسماءكم – ويمكن تعديل البنود والمجموعات لاحقًا في الشهر.",
        hhNamePh: "اسم المنزل",
        hhMePh: "اسمك",
        hhPartnerPh: "اسم الشريك",
        hhWelcomeHint: "حدّد الرصيد الابتدائي وشهر البداية في الإعدادات (⚙).",
        hhDone: "تم",
        loanMoneyTitle: "في الرصيد",
        loanCountedIn: "{{amount}} محسوب كدخل في {{month}} (\"{{item}}\").",
        loanCountedOut: "{{amount}} محسوب كمصروف في {{month}} (\"{{item}}\").",
        loanCountedEarlier: "محسوب في الرصيد من قبل.",
        loanUnbook: "تراجع",
        loanNotCounted: "ليس في الرصيد – لم يُحسب {{kind}} بعد.",
        loanMaybeCounted: "دين قديم: هل المال مسجل {{kind}}؟ إن لم يكن، سجّله في الشهر الصحيح هنا.",
        loanAsIncome: "كدخل",
        loanAsExpense: "كمصروف",
        loanBookInBtn: "تسجيل كدخل",
        loanBookOutBtn: "تسجيل كمصروف",
        loanAlreadyCounted: "مسجل مسبقًا",
        loanBookedToast: "سُجّل الدين في الرصيد",
        loanUnbookedToast: "أُلغي التسجيل",
        loanListNotCounted: "ليس في الرصيد – اضغط لتسجيله {{kind}}",
        loanListCheck: "في الرصيد؟ اضغط للتحقق والتسجيل",
        editStart: "تعديل",
        editDone: "تم",
        editOnToast: "التعديل مفعّل – يمكن تغيير الحقول",
        editOffToast: "وضع العرض – الحقول مقفلة",
        wgTitle: "أين ذهب المال · {{month}}",
        wgSpent: "مصروف",
        wgNone: "لا مصاريف مسجلة للشهر الماضي بعد.",
        wgFlow: "الدخل وأين ذهب",
        wg_needs: "حاجات",
        wg_wants: "رغبات",
        wg_once: "لمرة واحدة",
        wg_debt: "سداد ديون",
        wg_left: "متبقٍ",
        wgShort: "صُرف {{amount}} أكثر من الدخل",
        wgHint: "الحلقة تُظهر مصاريف آخر شهر منتهٍ حسب المجموعات (دون التوفير والديون). والشريط يقسم دخل ذلك الشهر إلى حاجات ورغبات ومصاريف لمرة واحدة وسداد ديون وما تبقى.",
        ycEvery: "كل {{n}} أشهر",
        ycShowAll: "عرض الكل ({{n}})",
        ycShowLess: "عرض أقل",
        loanRate: "الفائدة السنوية ٪ (اختياري)",
        healthTitle: "صحة المال",
        healthSub: "الاحتياطي يكفي {{n}} أشهر",
        healthSubNone: "صندوق الطوارئ، نسبة الادخار، الحاجات والرغبات",
        healthWhy: "لماذا؟",
        efTitle: "صندوق الطوارئ",
        efMonths: "{{n}} أشهر",
        efCore: "التكاليف الأساسية {{amount}} / شهر",
        efHave: "المتوفر",
        ef3: "هدف 3 أشهر",
        ef6: "هدف 6 أشهر",
        efNoAccounts: "محسوب من رصيد التطبيق. أدخل أرصدتكم الحقيقية في المزيد ← الحسابات لدقة أكبر.",
        efHint: "التكاليف الأساسية = ما تحتاجونه فعلًا كل شهر (الإيجار، الفواتير، التأمين، الطعام …)، متوسط آخر 3 أشهر منتهية؛ لا تُحسب المجموعات المعلَّمة كـ\"رغبة\" ولا البنود لمرة واحدة. الهدف 3 أشهر على الأقل و6 لأمان أكبر، ويفضَّل في حساب توفير بفائدة وسحب فوري.",
        srTitle: "نسبة الادخار",
        srRule: "ادّخر أولًا:",
        srOff: "إيقاف",
        srPayday: "ضع جانبًا {{amount}} هذا الشهر ({{pct}} ٪ من دخل {{income}}) – والأفضل يوم الراتب.",
        srDone: "تم ✓",
        srSoFar: "المحوَّل إلى \"التوفير\" حتى الآن: {{amount}}",
        srHint: "نسبة الادخار = (الدخل − المصروف) ÷ الدخل. لا تُحسب الديون والتحويلات من/إلى التوفير؛ وسداد الديون يُحسب ادخارًا لأنه يقلل ما عليكم. ادخار نسبة ثابتة يعني أن كل زيادة في الدخل تزيد الادخار تلقائيًا.",
        nwTitle: "الحاجات والرغبات",
        nwShare: "نسبة الرغبات في {{month}}",
        nwWant: "رغبة",
        nwNeed: "حاجة",
        nwRising: "نسبة الرغبات ترتفع منذ 3 أشهر.",
        nwHint: "اضغط على مجموعة لتعليمها كحاجة أو رغبة. قاعدة 50/30/20: نحو النصف للحاجات، حتى 30٪ للرغبات، و20٪ للادخار. أنفقوا بسخاء على ما تحبونه حقًا وقلّلوا الباقي.",
        ycTitle: "التكاليف الثابتة سنويًا",
        ycAll: "كل التكاليف الثابتة / سنة",
        ycSubs: "منها الاشتراكات / سنة",
        ycFees: "رسوم البنك (آخر 12 شهرًا)",
        ycHint: "المبالغ الشهرية تبدو صغيرة؛ على مستوى السنة ترى الكلفة الحقيقية للعقد. راجعوا العقود مرة في السنة وألغوا ما لا تستخدمونه.",
        dbTitle: "الديون حسب الفائدة",
        dbNone: "لا ديون مفتوحة.",
        dbExpensive: "سدّدوا الديون بفائدة أعلى من 8٪ قبل الاستثمار.",
        dbHint: "سدّدوا الدين الأغلى أولًا. أدخل الفائدة في الدين (✎). دين العائلة بلا فائدة رخيص – لا عجلة، لكن سدّدوه بانتظام.",
        wtTitle: "صافي الثروة",
        wtNow: "اليوم (المال − الديون + المستحق لكم)",
        wtHint: "الخط هو مالكم في نهاية كل شهر حسب التطبيق؛ النقطة الخضراء هي اليوم. صافي الثروة = المال ناقص الديون المفتوحة زائد ما يدين به الآخرون لكم. الدخل يدفع الحياة، والثروة تشتري الحرية.",
        wlTitle: "قائمة الرغبات (72 ساعة)",
        wlSub: "اشترِ الرغبات بعد 3 أيام فقط",
        wlSaved: "وفّرتم {{amount}} بالاستغناء",
        wlNamePh: "ماذا تريد أن تشتري؟",
        wlAdd: "إضافة رغبة",
        wlEmpty: "رغبة جديدة فوق 50 €؟ أضفها هنا وانتظر 3 أيام.",
        wlWait: "بقي {{h}} ساعة للانتظار",
        wlReady: "هل ما زلت تريده؟",
        wlSkip: "استغنِ",
        wlBuy: "اشترِ",
        wlSkippedN: "{{n}} رغبات متروكة · وُفّر {{amount}}",
        newLoanTitle: "دين جديد",
        loanNewBtn: "دين جديد",
        loanNoneOpen: "لا ديون مفتوحة.",
        loanBorrowed: "استلفت",
        loanLent: "أقرضت",
        loanBorrowerLabel: "لمن؟",
        loanPersonPh: "مثلًا: الأخت، آرام …",
        loanBookIn: "تسجيله كدخل في {{month}}",
        loanBookOut: "تسجيله كمصروف في {{month}}",
        loanBookHint: "ألغِ التحديد إن لم يمر المال عبر حساباتكم.",
        loanInstallments: "السداد على دفعات",
        loanBackInstallments: "السداد المتوقع على دفعات",
        loanNoPlan: "بدون",
        loanFirstMonth: "الدفعة الأولى",
        loanPreview: "{{n}} × {{amount}} · {{months}}",
        loanSave: "حفظ",
        loanFromItem: "دين من",
        loanRepayItem: "سداد إلى",
        lentToItem: "إقراض إلى",
        repaidByItem: "سداد من",
        loanAdded: "حُفظ الدين: {{amount}} · {{person}}",
        loanNeedFields: "أدخل الشخص والمبلغ والتاريخ.",
        loanShared: "خطة السداد هذه تشمل {{n}} ديون معًا ({{amount}})؛ تذهب الدفعات للأقدم أولًا.",
        loanEditTitle: "تعديل الدين",
        loanEditExisting: "عدّل الدين الموجود بدلًا من ذلك",
        loanPerson: "الشخص",
        loanAmount: "المبلغ",
        loanDate: "التاريخ",
        loanType: "النوع",
        loanSchedule: "خطة السداد",
        loanPlan: "مخطط",
        loanPaid: "مدفوع",
        loanAddMonth: "+ إضافة شهر …",
        loanRemaining: "غير مجدول بعد",
        loanPlannedOk: "كله مجدول ✓",
        loanPlannedGap: "دفعات السداد لا تساوي المبلغ كاملًا بعد. أضف شهرًا أو غيّر مبلغًا.",
        loanNoSchedule: "لا سداد مجدول بعد.",
        iconLabel: "الأيقونة",
        iconAuto: "تلقائي",
        iconAi: "اقتراح الذكاء الاصطناعي",
        iconsAiTool: "إيجاد الأيقونات الناقصة بالذكاء الاصطناعي",
        iconsDone: "عُيّنت {{n}} أيقونات",
        iconsNone: "لم توجد أيقونات مناسبة.",
        gestureTip: "نصيحة: اسحب جانبًا لتغيير الشهر · اضمم بإصبعين لطي كل المجموعات، وافتحهما لفتحها.",
        loansTitle: "الديون والقروض",
        toolsTitle: "الأدوات",
        toolSettings: "الإعدادات والنسخ الاحتياطي",
        toolGroups: "مجموعة جديدة",
        toolLang: "اللغة: العربية",
        tidyTitle: "ترتيب الفئات",
        tidyIntro: "اقتراح: نقل {{n}} بنود إلى مجموعات أنسب.",
        tidyApply: "تطبيق",
        tidyDone: "أُعيد ترتيب {{n}} بنود",
        tidyNone: "كل شيء مرتب جيدًا.",
        addReceiptShort: "إضافة إيصال",
        sectionMonth: "الشهر",
        logBtn: "السجل",
        askBtn: "اسأل",
        askTitle: "مساعد المنزل",
        askIntro: "اسأل أي شيء عن أرقامكم – بالعربية أو الإنجليزية أو الألمانية. المساعد يقرأ القيود ولا يغيّرها.",
        askEx1: "كم صرفنا على البقالة منذ أيلول؟",
        askEx2: "لماذا تشرين الثاني أقل من تشرين الأول؟",
        askEx3: "هل هناك شيء غير منطقي هذا الشهر؟",
        askPlaceholder: "اكتب سؤالًا …",
        askSend: "إرسال",
        askNew: "محادثة جديدة",
        askThinking: "يفكر …",
        askPrivacy: "تُرسل أرقامكم إلى Claude (Anthropic) للإجابة.",
        askNeedSignIn: "سجّل الدخول بـ Google أولًا (الإعدادات).",
        askErrSetup: "المساعد غير مُعدّ بعد (مفتاح API في Vercel مفقود أو خاطئ).",
        askErrNotAllowed: "حساب Google هذا غير مسموح له باستخدام المساعد (ALLOWED_EMAILS في Vercel).",
        askErrBusy: "طلبات كثيرة الآن – حاول بعد قليل.",
        askErrRefused: "لا يستطيع المساعد الإجابة على هذا. أعد الصياغة.",
        askErrOffline: "لا يوجد اتصال بالإنترنت.",
        askErrGeneric: "لم ينجح ذلك. حاول مرة أخرى.",
        logTitle: "سجل التغييرات",
        logAll: "الكل",
        logEmpty: "لا تغييرات محفوظة بعد. من الآن يُحفظ كل تغيير هنا مع تاريخه.",
        logPlan: "تغيّر المخطط",
        logReceived: "وصل",
        logPaid: "دُفع",
        logTxAdd: "أُضيف إيصال {{day}}",
        logTxDel: "حُذف إيصال {{day}}",
        logTxEdit: "عُدّل إيصال {{day}}",
        logStart: "الرصيد الافتتاحي",
        logBulk: "تغيّرت {{n}} قيم دفعة واحدة (استيراد أو استعادة)",
        logNote: "آخر {{n}} تغييرًا تُحفظ مع بياناتك وتتزامن.",
        viewEnd: "آخر الشهر",
        viewNow: "الآن",
        nowTitle: "الرصيد الآن (حسب القيود)",
        nowReceived: "وصل حتى الآن",
        nowPaid: "دُفع وصُرف حتى الآن",
        nowStillOpen: "ما زال مفتوحًا حتى آخر الشهر",
        nowRules: "يحسب فقط ما هو مؤشّر عليه أو مُدخل. الخطط المفتوحة تُضاف فقط في \"آخر الشهر\".",
        txModalTitle: "قيود {{month}}",
        txEmpty: "لا قيود مفردة بعد. الإيصالات وكشوف الحساب المستوردة تظهر هنا.",
        rangeMonth: "الشهر",
        howOften: "كم مرة؟",
        recurringLabel: "متكرر",
        recurringHelp: "يتكرر كل شهر أو بإيقاع ثابت.",
        onceHelp: "مرة واحدة فقط في شهر واحد، ولا يظهر في غيره.",
        variableItemHelp: "بلا مبلغ ثابت: أضف الإيصالات بـ +. الهدف الشهري يشمل المجموعة كلها.",
        clearOutside: "اجعل المخطط 0 خارج هذه الفترة",
        clearOutsideHint: "يزيل المخطط من كل الأشهر الأخرى. المبالغ الفعلية تبقى كما هي.",
        replicateTitle: "تحديد مبلغ لفترة",
        replicateCatLabel: "الفئة",
        replicateFieldLabel: "أي قيمة؟",
        replicateBudgetOption: "المخطط (الميزانية)",
        replicateActualOption: "الفعلي (المصروف)",
        replicateAmountLabel: "المبلغ (€)",
        replicateDurationLabel: "المدة",
        duration3: "3 أشهر ({{month}} + 2)",
        duration6: "6 أشهر ({{month}} + 5)",
        duration12: "12 شهرًا (سنة)",
        durationAll: "حتى نهاية 2028",
        replicateActionBtn: "تطبيق",
        loanModalTitle: "تسجيل دين",
        loanModalDesc: "يضيف المال المستلم كدخل ويجدول السداد كمصاريف في الأشهر المختارة:",
        loanStep1: "1. المال المستلم (دخل {{month}} {{year}})",
        loanStep2: "2. جدولة السداد (مصاريف)",
        loanReceivedAmountLabel: "المال المستلم",
        loanLenderLabel: "ممن استلفت؟",
        loanIncomeCatLabel: "اسم بند الدخل",
        loanExpenseCatLabel: "اسم بند السداد",
        loanInst1Month: "شهر الدفعة الأولى",
        loanInst2Month: "شهر الدفعة الثانية",
        loanConfirmBtn: "تسجيل في المداخيل والمصاريف",
        loanSuccessAlert: "سُجّل الدين! {{inAmount}} كدخل في {{inMonth}}، وجُدولت دفعات {{a1}} في {{m1}} و{{a2}} في {{m2}}.",
        breakdownTitle: "تفاصيل {{month}} {{year}}",
        breakdownIncomes: "كل مداخيل هذا الشهر (المجموع: {{total}}):",
        breakdownExpenses: "كل مصاريف هذا الشهر (المجموع: {{total}}):",
        breakdownNetResult: "النتيجة (الصافي الفعلي = المداخيل ناقص المصاريف):",
        noItemsInBreakdown: "لا معاملات مسجلة.",
        closeBtn: "إغلاق",
        deleteItemTitle: "حذف البند: {{name}}",
        deleteFutureOnly: "مسح الأشهر القادمة فقط",
        deleteFutureOnlyDesc: "تبقى سجلات الأشهر الماضية والحالية كما هي.",
        deletePurgeMerge: "حذف كامل ونقل إلى '{{fallback}}'",
        deletePurgeMergeDesc: "بلا خسارة في الرصيد. كل المبالغ والملاحظات تبقى.",
        deleteFallbackBlocked: "\"{{name}}\" هي الفئة العامة ولا يمكن دمجها في نفسها.",
        cancelBtn: "إلغاء",
        duplicateAlert: "الفئة موجودة مسبقًا: \"{{name}}\" ({{bracket}})",
        hideWhenZeroHint: "إخفاء في الأشهر بلا نشاط",
        fallbackCategory: "أخرى",
        brackets: {
          housing: "السكن والمصاريف الثابتة",
          subscriptions: "الاشتراكات والإعلام",
          living: "المعيشة اليومية والبقالة",
          professional: "التعليم والصحة",
          leisure: "الترفيه والثقافة",
          other: "أخرى وديون",
          fixed_in: "دخل ثابت / حساب مجمّد",
          variable_in: "دخل متغير وديون"
        },
        months: MONTH_NAMES.ar
      }
    };

    const LanguageContext = createContext();
    function LanguageProvider({ children }) {
      const [lang, setLang] = useState(() => { const v = safeStorage.get('budget_app_lang', 'de'); return ['de', 'en', 'ar'].includes(v) ? v : 'de'; });
      const changeLanguage = (l) => { setLang(l); safeStorage.set('budget_app_lang', l); };

      useEffect(() => {
        document.documentElement.lang = lang;
        document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
      }, [lang]);

      const getNested = (obj, path) => {
        if (!obj) return undefined;
        return path.split('.').reduce((acc, part) => (acc && acc[part] !== undefined) ? acc[part] : undefined, obj);
      };

      const t = (path, params = {}) => {
        let res = getNested(translations[lang], path) || getNested(translations['en'], path);
        if (res === undefined) {
          if (path.startsWith('months.')) return path.replace('months.', '');
          if (path.startsWith('brackets.')) return path.replace('brackets.', '');
          return path;
        }
        if (typeof res === 'string') {
          Object.keys(params).forEach(p => { res = res.replace(new RegExp(`{{${p}}}`, 'g'), params[p]); });
        }
        return res;
      };
      return <LanguageContext.Provider value={{ t, lang, changeLanguage }}>{children}</LanguageContext.Provider>;
    }
    const useTranslation = () => useContext(LanguageContext);

    const IDB = {
      dbName: 'LiquidCashflow_vStrictNotionComplete',
      open() {
        return new Promise((res, rej) => {
          const r = indexedDB.open(this.dbName, 1);
          r.onupgradeneeded = (e) => e.target.result.createObjectStore('store', { keyPath: 'id' });
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      },
      async get(k) {
        try {
          const db = await this.open();
          return new Promise(res => {
            const tx = db.transaction('store', 'readonly');
            const req = tx.objectStore('store').get(k);
            req.onsuccess = () => res(req.result?.data);
            req.onerror = () => res(null);
          });
        } catch(e) { return null; }
      },
      async set(k, data) {
        try {
          const db = await this.open();
          return new Promise((res, rej) => {
            const tx = db.transaction('store', 'readwrite');
            tx.objectStore('store').put({ id: k, data });
            tx.oncomplete = () => res(true);
            tx.onerror = () => rej(tx.error);
          });
        } catch(e) {}
      }
    };

    const emptyNode = () => ({ budget: 0, actual: 0, asOfDate: null });

    // One automatic snapshot per day on this device; the last 14 days are kept.
    const BACKUP_DAYS = 14;
    const saveDailyBackup = async (snapshot) => {
      try {
        const key = cacheKey('backups');
        const list = (await IDB.get(key)) || [];
        const day = todayISO();
        if (list.length && list[list.length - 1].day === day) return;
        list.push({ day, ts: Date.now(), data: snapshot });
        await IDB.set(key, list.slice(-BACKUP_DAYS));
      } catch (e) { console.warn('Backup failed', e); }
    };

    // Case-insensitive dedupe so the same category never counts twice.
    const dedupe = (list) => {
      const seen = new Set();
      const out = [];
      (list || []).forEach(c => {
        if (typeof c !== 'string') return;
        const val = c.trim();
        const key = val.toLowerCase();
        if (val && !seen.has(key)) { seen.add(key); out.push(val); }
      });
      return out;
    };

    const cleanNotes = (list) => Array.isArray(list) ? list.filter(n => typeof n === 'string') : [];

    /*
      State shape (version 3):
        groups           = [{ id, kind: fixed|variable|oneoff, color, name|null }]  (expense groups)
        targets[groupId][year][month] = monthly target of a variable group
        meta.expenses[cat] = { bracket: groupId, mode, oneTime, payDay }  (mode/oneTime follow the group)
        meta.incomes[cat]  = { bracket, mode, oneTime, payDay }
        notes[type][cat] = { "2026_Okt": ["..."] }
        values[year][type][cat][month] = { budget, actual, asOfDate|null, receipts? }
      Version 2 had no groups: items are sorted into groups by name, and the plans of
      variable items become their group's target.
      Version 1 kept metadata in flat name-keyed maps shared by incomes and expenses,
      so a name used on both sides ("Sonstiges") overwrote itself. It is migrated here.
    */
    // Clothes and shoes: words in item or group names (German, English, Arabic).
    const CLOTHES_RE = /kleid|cloth|klamott|schuh|shoe|sneaker|jacke|jacket|mantel|hose\b|jeans|ملابس|ملبوسات|أحذية|احذية|حذاء/i;
    const isClothingItem = (name) => CLOTHES_RE.test(name) || MERCHANTS.some(e => e[1].startsWith('clothing') && e[2]
      && [e[0], ...(e[3] || [])].some(w => w.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(name)));

    // Shops that sell a bit of everything: the Add form asks what was bought there.
    const MULTI_SHOP_RE = /amazon|\bamzn\b|ebay|temu|shein|aliexpress|kaufland|\blidl\b|\baldi\b|\botto\b|\baction\b|\btedi\b|woolworth|galeria|kaufhof|tk\s*maxx|kleinanzeigen|marktkauf|globus|thomas\s*philipps|primark|zalando|about\s*you|\bkik\b/i;

    const normalizeState = (raw) => {
      const isLegacy = !!raw && !raw.meta;
      const needsGroups = !Array.isArray(raw?.groups) || raw.groups.length === 0;
      const groups = needsGroups
        ? DEFAULT_GROUPS.map(g => ({ ...g }))
        : raw.groups
            .filter(g => g && typeof g.id === 'string')
            .map(g => ({
              id: g.id,
              kind: GROUP_KINDS.includes(g.kind) ? g.kind : 'fixed',
              color: GROUP_COLORS.includes(g.color) ? g.color : 'gray',
              name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : null
            }));
      const state = {
        version: 4,
        startingCapital: typeof raw?.startingCapital === 'number' ? raw.startingCapital : 0,
        // The month whose start the starting capital describes; earlier months don't feed the balance.
        startingMonth: TIMELINE.some(x => timelineKey(x.yr, x.m) === raw?.startingMonth)
          ? raw.startingMonth
          : timelineKey(TIMELINE[0].yr, TIMELINE[0].m),
        brackets: {
          incomes: raw?.brackets?.incomes || [...DEFAULT_BRACKETS.incomes]
        },
        groups,
        targets: {},
        categories: {
          incomes: dedupe(raw?.categories?.incomes || INITIAL_CATEGORIES.incomes),
          expenses: dedupe(raw?.categories?.expenses || INITIAL_CATEGORIES.expenses)
        },
        meta: { incomes: {}, expenses: {} },
        notes: { incomes: {}, expenses: {} },
        ious: (raw?.ious || []).map(i => ({ ...i, type: i.type || 'borrowed' })),
        // Version 4: household members, single entries (receipts, imports), learned payee
        // rules for imports, savings goals, and which bank lines were already imported.
        members: {
          me: typeof raw?.members?.me === 'string' && raw.members.me.trim() ? raw.members.me.trim() : 'Mohammed',
          partner: typeof raw?.members?.partner === 'string' && raw.members.partner.trim() ? raw.members.partner.trim() : 'Mai'
        },
        tx: [],
        rules: raw?.rules && typeof raw.rules === 'object' ? { ...raw.rules } : {},
        goals: (Array.isArray(raw?.goals) ? raw.goals : [])
          .filter(g => g && typeof g.id === 'string' && typeof g.name === 'string')
          .map(g => ({
            id: g.id, name: g.name,
            target: typeof g.target === 'number' ? g.target : 0,
            saved: typeof g.saved === 'number' ? g.saved : 0,
            deadline: typeof g.deadline === 'string' ? g.deadline : null
          })),
        imported: Array.isArray(raw?.imported) ? raw.imported.filter(k => typeof k === 'string') : [],
        // Change history: when which amount was changed, by whom (newest last).
        log: (Array.isArray(raw?.log) ? raw.log : []).filter(e => e && typeof e.t === 'string' && typeof e.k === 'string').slice(-LOG_MAX),
        // Icon chosen per item name (by hand or by the AI); others are picked automatically.
        icons: Object.fromEntries(Object.entries(raw?.icons && typeof raw.icons === 'object' ? raw.icons : {})
          .map(([k, v]) => [k, validIcon(v)]).filter(([, v]) => v)),
        // Bank and cash accounts with the balance last checked (main = Revolut, gateway = Wise/Sparkasse).
        accounts: (Array.isArray(raw?.accounts) ? raw.accounts : [])
          .filter(a => a && typeof a.id === 'string' && typeof a.name === 'string')
          .map(a => ({
            id: a.id, name: a.name,
            kind: ['main', 'gateway', 'cash', 'savings'].includes(a.kind) ? a.kind : 'main',
            balance: typeof a.balance === 'number' ? a.balance : 0,
            updated: typeof a.updated === 'string' ? a.updated : null
          })),
        // Day the salary arrives (15–31). With it, the budget month runs from payday to the day before.
        payday: Number.isInteger(raw?.payday) && raw.payday >= 15 && raw.payday <= 31 ? raw.payday : null,
        name: typeof raw?.name === 'string' ? raw.name.slice(0, 60) : '',
        // Money health: which groups are wants, and the share of income to save first.
        health: {
          wants: raw?.health?.wants && typeof raw.health.wants === 'object' ? Object.fromEntries(Object.entries(raw.health.wants).map(([k, v]) => [k, !!v])) : {},
          savePct: typeof raw?.health?.savePct === 'number' && raw.health.savePct >= 0 && raw.health.savePct <= 80 ? raw.health.savePct : 0
        },
        // Things you'd like to buy: they wait 72 hours before you decide.
        // Money moved between your own accounts: never income or spending.
        transfers: (Array.isArray(raw?.transfers) ? raw.transfers : [])
          .filter(x => x && typeof x.id === 'string' && typeof x.amount === 'number' && typeof x.date === 'string')
          .map(x => ({ id: x.id, date: x.date, amount: x.amount, from: typeof x.from === 'string' ? x.from : '', to: typeof x.to === 'string' ? x.to : '',
            note: typeof x.note === 'string' ? x.note : '', moved: !!x.moved })),
        wishlist: (Array.isArray(raw?.wishlist) ? raw.wishlist : [])
          .filter(w => w && typeof w.id === 'string' && typeof w.name === 'string')
          .map(w => ({ id: w.id, name: w.name, amount: typeof w.amount === 'number' ? w.amount : 0,
            added: typeof w.added === 'string' ? w.added : new Date().toISOString(),
            status: ['wait', 'bought', 'skipped'].includes(w.status) ? w.status : 'wait', decided: typeof w.decided === 'string' ? w.decided : null })),
        values: {}
      };

      const sourceMeta = (type, cat) => {
        if (!raw) return { oneTime: DEFAULT_ONE_TIME[cat] };
        if (isLegacy) {
          return {
            bracket: raw.categoryOverrides?.[cat],
            mode: raw.categoryModes?.[cat],
            oneTime: raw.categoryOneTime ? raw.categoryOneTime[cat] : DEFAULT_ONE_TIME[cat],
            payDay: raw.fixedPaymentDays?.[cat]
          };
        }
        return raw.meta?.[type]?.[cat] || {};
      };

      const legacyExpenseBrackets = DEFAULT_BRACKETS.expenses.map(b => b.id);
      const groupIds = groups.map(g => g.id);

      TYPES.forEach(type => {
        const valid = type === 'expenses' ? legacyExpenseBrackets : state.brackets[type].map(b => b.id);
        state.categories[type].forEach(cat => {
          const src = sourceMeta(type, cat);
          const auto = autoClassifyCategory(cat);

          let mode = (src.mode === 'fixed' || src.mode === 'variable') ? src.mode : null;
          if (!mode) {
            mode = type === 'expenses'
              ? auto.mode
              : (/side|sonstiges|other|savings|darlehen|loan/i.test(cat) ? 'variable' : 'fixed');
          }

          let bracket = valid.includes(src.bracket) ? src.bracket : null;
          if (!bracket) {
            const guess = type === 'expenses' ? auto.bracket : (mode === 'fixed' ? 'fixed_in' : 'variable_in');
            bracket = valid.includes(guess) ? guess : valid[0];
          }

          const oneTime = typeof src.oneTime === 'boolean' ? src.oneTime : (type === 'expenses' ? auto.isOneTime : false);
          const payDay = Number.isInteger(src.payDay) && src.payDay >= 1 && src.payDay <= 31 ? src.payDay : null;

          if (type === 'expenses') {
            let groupId = !needsGroups && groupIds.includes(src.bracket) ? src.bracket : null;
            if (!groupId) {
              const guess = legacyGroupFor(cat, { mode, oneTime, bracket: valid.includes(src.bracket) ? src.bracket : bracket });
              groupId = groupIds.includes(guess) ? guess : groupIds[0];
            }
            state.meta.expenses[cat] = metaForGroup(groups, groupId, payDay, !needsGroups && src.once === true, !needsGroups && src.forNext === true);
            return;
          }
          // Income that arrives at the end of a month (e.g. salary on the 26th) and pays for the next one.
          state.meta[type][cat] = { bracket, mode, oneTime, payDay, forNext: src.forNext === true };
        });
      });

      if (isLegacy) {
        Object.entries(raw.categoryNotes || {}).forEach(([key, list]) => {
          const match = /^(\d{4})_([^_]+)_(.+)$/.exec(key);
          const notes = cleanNotes(list);
          if (!match || !notes.length) return;
          const [, yr, mo, cat] = match;
          const type = state.categories.expenses.includes(cat) ? 'expenses'
            : state.categories.incomes.includes(cat) ? 'incomes' : null;
          if (!type) return;
          if (!state.notes[type][cat]) state.notes[type][cat] = {};
          state.notes[type][cat][`${yr}_${mo}`] = notes;
        });
      } else if (raw) {
        TYPES.forEach(type => state.categories[type].forEach(cat => {
          Object.entries(raw.notes?.[type]?.[cat] || {}).forEach(([monthKey, list]) => {
            const notes = cleanNotes(list);
            if (!notes.length) return;
            if (!state.notes[type][cat]) state.notes[type][cat] = {};
            state.notes[type][cat][monthKey] = notes;
          });
        }));
      }

      YEARS.forEach(yr => {
        const y = String(yr);
        state.values[y] = { incomes: {}, expenses: {} };
        TYPES.forEach(type => state.categories[type].forEach(cat => {
          state.values[y][type][cat] = {};
          getMonthsForYear(yr).forEach(m => {
            const old = raw?.values?.[y]?.[type]?.[cat]?.[m];
            const node = emptyNode();
            if (typeof old === 'number') {
              node.budget = old;
              node.actual = old;
            } else if (old && typeof old === 'object') {
              node.budget = typeof old.budget === 'number' ? old.budget : (parseFloat(old.total) || 0);
              node.actual = typeof old.actual === 'number' ? old.actual : (parseFloat(old.total) || 0);
              // v1 filled asOfDate with the month length by default; only keep real manual values.
              if (typeof old.asOfDate === 'number' && old.asOfDate >= 1 && old.asOfDate < getDaysInMonth(yr, m)) {
                node.asOfDate = Math.round(old.asOfDate);
              }
              if (typeof old.receipts === 'number' && old.receipts > 0) node.receipts = Math.round(old.receipts);
            }
            state.values[y][type][cat][m] = node;
          });
        }));
      });

      groups.filter(g => g.kind === 'variable').forEach(g => {
        state.targets[g.id] = {};
        YEARS.forEach(yr => {
          const y = String(yr);
          state.targets[g.id][y] = {};
          getMonthsForYear(yr).forEach(m => {
            const old = raw?.targets?.[g.id]?.[y]?.[m];
            state.targets[g.id][y][m] = !needsGroups && typeof old === 'number' && old > 0 ? old : 0;
          });
        });
      });

      state.tx = (Array.isArray(raw?.tx) ? raw.tx : [])
        .filter(x => x && typeof x.id === 'string' && TYPES.includes(x.type) && typeof x.amount === 'number'
          && dateToMonth(x.date) && state.categories[x.type].includes(x.cat))
        .map(x => ({
          id: x.id, date: x.date, type: x.type, cat: x.cat, amount: x.amount,
          who: WHO.includes(x.who) ? x.who : null,
          note: typeof x.note === 'string' ? x.note : '',
          source: ['import', 'legacy', 'tick', 'loan'].includes(x.source) ? x.source : 'manual',
          account: typeof x.account === 'string' ? x.account : null,
          undated: !!x.undated
        }));

      // Engine 5: every real amount is an entry. Amounts typed straight into a month before
      // this became entries once ("from before", without a day when the item has no due day),
      // with ids that are the same on every device, so two phones migrating agree.
      if (raw?.engine !== 5) {
        const sums = {};
        state.tx.forEach(x => { const p = dateToMonth(x.date); if (p) { const k = `${x.type}|${x.cat}|${p.yr}|${p.m}`; sums[k] = (sums[k] || 0) + x.amount; } });
        const hash = (str) => { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
        TYPES.forEach(type => state.categories[type].forEach(cat => {
          const pd = state.meta[type]?.[cat]?.payDay;
          YEARS.forEach(yr => getMonthsForYear(yr).forEach(m => {
            const node = state.values[yr]?.[type]?.[cat]?.[m];
            if (!node) return;
            const rest = Math.round((node.actual - (sums[`${type}|${cat}|${yr}|${m}`] || 0)) * 100) / 100;
            if (rest <= 0.005) return;
            const days = getDaysInMonth(yr, m);
            const day = Number.isInteger(pd) ? Math.min(Math.max(pd, 1), days) : 1;
            state.tx.push({ id: `lg_${yr}_${m}_${type[0]}_${hash(cat)}`, date: `${yr}-${pad2(ALL_MONTHS.indexOf(m) + 1)}-${pad2(day)}`,
              type, cat, amount: rest, who: null, note: '', source: 'legacy', account: null, undated: !Number.isInteger(pd) });
          }));
        }));
      }
      state.engine = 5;

      // Clothes get their own group (once): add it unless one exists, and move clothing items into it.
      // Their entries follow them, so all past months are re-sorted too.
      if (!raw?.clothesV1 && !needsGroups) {
        let cg = state.groups.find(g => g.id === 'clothing') || state.groups.find(g => g.kind !== 'fixed' && CLOTHES_RE.test(g.name || ''));
        if (!cg) {
          cg = { id: 'clothing', kind: 'variable', color: 'indigo', name: null };
          const at = state.groups.findIndex(g => g.id === 'household');
          state.groups.splice(at >= 0 ? at + 1 : state.groups.length, 0, cg);
        }
        state.categories.expenses.forEach(cat => {
          const meta = state.meta.expenses[cat];
          const g = state.groups.find(x => x.id === meta?.bracket);
          if (!meta || meta.bracket === cg.id || (g && g.kind === 'fixed') || !isClothingItem(cat)) return;
          state.meta.expenses[cat] = cg.kind === 'variable'
            ? { ...metaForGroup(state.groups, cg.id, meta.payDay ?? null, false), once: false, oneTime: false }
            : metaForGroup(state.groups, cg.id, meta.payDay ?? null, !!meta.once);
        });
      }
      state.clothesV1 = true;

      // Moving to groups: the plans of variable items add up to their group's target.
      if (needsGroups) {
        state.categories.expenses.forEach(cat => {
          const gid = state.meta.expenses[cat].bracket;
          if (!state.targets[gid]) return;
          YEARS.forEach(yr => getMonthsForYear(yr).forEach(m => {
            const node = state.values[String(yr)].expenses[cat][m];
            state.targets[gid][String(yr)][m] += node.budget;
            node.budget = 0;
          }));
        });
      }
      return state;
    };

    function Modal({ title, onClose, children, size = 'max-w-sm', titleClass = 'text-primary', inline = false }) {
      useEffect(() => {
        if (inline) return;
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose, inline]);

      // Inline: the same content as a panel inside a page (Activity tab).
      if (inline) {
        return <section className="rounded-2xl border border-subtle bg-surface p-4 space-y-3 text-xs">{children}</section>;
      }
      return (
        <div className="backdrop-in fixed inset-0 bg-black/60 backdrop-blur-sm z-[70] flex items-end sm:items-center justify-center sm:p-4"
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
          <div role="dialog" aria-modal="true" className={`sheet-in bg-surface border border-subtle rounded-t-2xl sm:rounded-2xl ${size} w-full p-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-3 shadow-2xl text-xs max-h-[92vh] overflow-y-auto`}>
            <div className="sm:hidden mx-auto -mt-1 mb-1 h-1 w-10 rounded-full bg-subtle"></div>
            <div className="flex justify-between items-center gap-2 border-b border-subtle pb-2">
              <h3 className={`font-semibold flex items-center gap-1.5 ${titleClass}`}>{title}</h3>
              <button onClick={onClose} aria-label="Close" className="text-secondary hover:text-primary p-1">
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
            {children}
          </div>
        </div>
      );
    }

    // A short buzz on Android phones; iPhones ignore it.
    const haptic = (ms = 8) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} };

    // Counts smoothly to a new value instead of jumping.
    function AnimatedNumber({ value, format }) {
      const [shown, setShown] = useState(value);
      const fromRef = useRef(value);
      useEffect(() => {
        const reduce = document.documentElement.dataset.motion === 'off';
        const from = fromRef.current;
        if (typeof value !== 'number' || typeof from !== 'number' || reduce || from === value) {
          fromRef.current = value; setShown(value); return;
        }
        let raf; const t0 = performance.now(); const D = 480;
        const step = (now) => {
          const k = Math.min(1, (now - t0) / D); const e = 1 - Math.pow(1 - k, 3);
          const v = from + (value - from) * e; fromRef.current = v; setShown(v);
          if (k < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
      }, [value]);
      return <>{format(shown)}</>;
    }

    // ---- Item icons: brand badges for shops and services, symbols for everything else ----
    // Symbols the app (and the AI) may choose from; all are in Font Awesome 6 free.
    const ICON_CHOICES = ['fa-house', 'fa-key', 'fa-bolt', 'fa-fire-flame-simple', 'fa-droplet', 'fa-wifi', 'fa-mobile-screen', 'fa-phone',
      'fa-radio', 'fa-tv', 'fa-train-subway', 'fa-bus', 'fa-car', 'fa-gas-pump', 'fa-bicycle', 'fa-plane', 'fa-dumbbell', 'fa-heart-pulse',
      'fa-pills', 'fa-kit-medical', 'fa-tooth', 'fa-glasses', 'fa-basket-shopping', 'fa-cart-shopping', 'fa-bread-slice', 'fa-apple-whole',
      'fa-mug-hot', 'fa-utensils', 'fa-burger', 'fa-pizza-slice', 'fa-couch', 'fa-chair', 'fa-shirt', 'fa-shoe-prints', 'fa-gift',
      'fa-cake-candles', 'fa-champagne-glasses', 'fa-masks-theater', 'fa-film', 'fa-music', 'fa-gamepad', 'fa-book', 'fa-graduation-cap',
      'fa-language', 'fa-shield-halved', 'fa-umbrella', 'fa-plug', 'fa-laptop', 'fa-mask', 'fa-file-lines', 'fa-file-invoice', 'fa-repeat',
      'fa-piggy-bank', 'fa-hand-holding-dollar', 'fa-building-columns', 'fa-briefcase', 'fa-coins', 'fa-people-roof', 'fa-baby', 'fa-paw',
      'fa-scissors', 'fa-spray-can-sparkles', 'fa-soap', 'fa-broom', 'fa-screwdriver-wrench', 'fa-box', 'fa-envelope', 'fa-cloud',
      'fa-robot', 'fa-credit-card', 'fa-receipt', 'fa-tag', 'fa-store', 'fa-seedling', 'fa-hospital',
      'fa-cookie-bite', 'fa-ice-cream', 'fa-wine-bottle', 'fa-bottle-water', 'fa-fish', 'fa-carrot', 'fa-egg', 'fa-cheese', 'fa-lemon',
      'fa-bag-shopping', 'fa-wallet', 'fa-gem', 'fa-ring', 'fa-mosque', 'fa-hand-holding-heart', 'fa-children', 'fa-child', 'fa-school',
      'fa-stethoscope', 'fa-syringe', 'fa-hand-holding-medical', 'fa-car-side', 'fa-taxi', 'fa-motorcycle', 'fa-square-parking', 'fa-truck',
      'fa-truck-fast', 'fa-box-open', 'fa-house-chimney', 'fa-building', 'fa-hotel', 'fa-suitcase', 'fa-ticket', 'fa-hammer', 'fa-paint-roller',
      'fa-lightbulb', 'fa-trash-can', 'fa-sim-card', 'fa-satellite-dish', 'fa-headphones', 'fa-camera', 'fa-print', 'fa-futbol',
      'fa-person-swimming', 'fa-ellipsis'];
    // Shops and services: short label in the brand's colours (no logos are loaded from anywhere).
    const BRANDS = [
      [/netto/i, 'N', '#FFE500', '#E2001A', 'si:netto'], [/edeka/i, 'E', '#1C4E9B', '#FFE500', 'si:edeka'], [/lidl/i, 'L', '#0050AA', '#FFF000', 'si:lidl'],
      [/\baldi\s*talk/i, 'AT', '#00005F', '#22B5EC'], [/\baldi\b/i, 'A', '#00005F', '#F59C00', 'si:aldisud'], [/\brewe\b/i, 'R', '#CC071E', '#FFFFFF'],
      [/kaufland/i, 'K', '#E10915', '#FFFFFF', 'si:kaufland'], [/\bpenny\b/i, 'P', '#CD1414', '#FFED00'], [/\bdm\b|dm-drogerie|drogerie markt/i, 'dm', '#002878', '#FFFFFF', 'si:dm'],
      [/rossmann/i, 'R', '#C3002F', '#FFFFFF', 'si:rossmann'], [/m[üu]ller\b/i, 'M', '#F39200', '#FFFFFF'], [/\baction\b/i, 'A', '#003C8F', '#FFFFFF', 'web:action.com'],
      [/\btedi\b/i, 'T', '#FFDD00', '#003C8F', 'web:tedi.com'], [/\bkodi\b/i, 'K', '#E30613', '#FFFFFF', 'web:kodi.de'], [/woolworth/i, 'W', '#E2001A', '#FFFFFF', 'web:woolworth.de'],
      [/\bikea\b/i, 'IK', '#0058A3', '#FFDB00', 'si:ikea'], [/amazon|\bamzn\b/i, 'a', '#232F3E', '#FF9900', 'web:amazon.de'], [/media\s*markt/i, 'MM', '#DF0000', '#FFFFFF', 'si:mediamarkt'],
      [/saturn/i, 'S', '#F06400', '#FFFFFF', 'si:saturn'], [/shein/i, 'S', '#111111', '#FFFFFF', 'web:shein.com'], [/c\s*&\s*a\b/i, 'C&A', '#1B3A93', '#FFFFFF', 'web:c-and-a.com'],
      [/h\s*&\s*m\b/i, 'H&M', '#E50010', '#FFFFFF', 'si:handm'], [/new\s*yorker/i, 'NY', '#111111', '#FFFFFF', 'web:newyorker.de'], [/deichmann/i, 'D', '#E2001A', '#FFFFFF', 'web:deichmann.com'],
      [/spotify/i, 'S', '#1DB954', '#0B0B0B', 'si:spotify'], [/netflix/i, 'N', '#0B0B0B', '#E50914', 'si:netflix'], [/disney/i, 'D+', '#0B1A6E', '#FFFFFF', 'web:disneyplus.com'],
      [/youtube/i, 'YT', '#FF0000', '#FFFFFF', 'si:youtube'], [/google/i, 'G', '#FFFFFF', '#4285F4', 'si:google'], [/apple|icloud/i, '', '#111111', '#FFFFFF', 'si:apple'],
      [/vodafone/i, 'V', '#E60000', '#FFFFFF', 'si:vodafone'], [/\bo2\b|telef[oó]nica/i, 'O₂', '#0019A5', '#FFFFFF'], [/telekom/i, 'T', '#E20074', '#FFFFFF', 'si:deutschetelekom'],
      [/congstar/i, 'c', '#2B2B2B', '#FFED00', 'web:congstar.de'], [/sparkasse/i, 'S', '#FF0000', '#FFFFFF', 'si:sparkasse'], [/volksbank/i, 'VB', '#003D8F', '#FF6600', 'web:vr.de'],
      [/revolut/i, 'R', '#191C1F', '#FFFFFF', 'si:revolut'], [/\bwise\b/i, 'W', '#9FE870', '#163300', 'si:wise'], [/paypal/i, 'P', '#003087', '#FFFFFF', 'si:paypal'],
      [/deutsche\s*bahn|\bdb\b|\bmo\.?pla\b/i, 'DB', '#EC0016', '#FFFFFF', 'si:deutschebahn'], [/\bswk\b|stadtwerke/i, 'SWK', '#00508F', '#FFFFFF', 'web:swk.de'],
      [/mc\s*fit|rsg\b/i, 'Mc', '#FFD100', '#111111', 'web:mcfit.com'], [/care\s*concept/i, 'CC', '#0A6E9E', '#FFFFFF', 'web:care-concept.de'], [/fintiba/i, 'F', '#5B2D8E', '#FFFFFF', 'web:fintiba.com'],
      [/claude|anthropic/i, 'C', '#D97757', '#FFFFFF', 'si:claude'], [/xiaomi/i, 'mi', '#FF6900', '#FFFFFF', 'si:xiaomi'], [/payback/i, 'P', '#0046AA', '#FFFFFF', 'si:payback'],
      [/mcdonald/i, 'M', '#DA291C', '#FFC72C', 'si:mcdonalds'], [/\bkfc\b/i, 'KFC', '#A3080C', '#FFFFFF', 'si:kfc'], [/burger\s*king/i, 'BK', '#F5EBDC', '#D62300', 'si:burgerking'],
      [/lieferando/i, 'L', '#FF8000', '#FFFFFF', 'web:lieferando.de'], [/wolt/i, 'W', '#00C2E8', '#FFFFFF', 'web:wolt.com'], [/\bdhl\b/i, 'DHL', '#FFCC00', '#D40511', 'si:dhl'],
      [/deutsche\s*post/i, 'P', '#FFCC00', '#111111', 'si:deutschepost'], [/rundfunk|\bard\b|\bzdf\b/i, 'ARD', '#00305E', '#FFFFFF', 'web:rundfunkbeitrag.de']
    ];
    const KEYWORD_ICONS = [
      [/miete|rent|wohnung|hause?\b/i, 'fa-house'], [/kaution|deposit/i, 'fa-key'], [/strom|electric/i, 'fa-bolt'],
      [/gas\b|heiz|heating/i, 'fa-fire-flame-simple'], [/wasser|water/i, 'fa-droplet'], [/internet|wlan|wifi|festnetz|kabel/i, 'fa-wifi'],
      [/handy|mobil|phone|s\d\d\s*ultra/i, 'fa-mobile-screen'], [/radio|rundfunk/i, 'fa-radio'], [/ticket|transport|bahn|bus\b|öpnv/i, 'fa-train-subway'],
      [/auto\b|\bcar\b|tank|benzin/i, 'fa-gas-pump'], [/gym|fitness|sport/i, 'fa-dumbbell'], [/apotheke|pharm|medik|medic/i, 'fa-pills'],
      [/gesundheit|health|arzt|doctor/i, 'fa-heart-pulse'], [/zahn|dent/i, 'fa-tooth'], [/lebensmittel|grocer|supermarkt|markt|einkauf/i, 'fa-basket-shopping'],
      [/bäcker|baecker|bakery|brot/i, 'fa-bread-slice'], [/mate|kaffee|coffee|tee\b|tea\b/i, 'fa-mug-hot'], [/essen|restaurant|food|imbiss|döner/i, 'fa-utensils'],
      [/hausrat|haushalt|household|möbel|furniture|sofa/i, 'fa-couch'], [/kleidung|cloth|apparel|schuh/i, 'fa-shirt'], [/geschenk|gift/i, 'fa-gift'],
      [/unterhaltung|kino|cinema|entertain|freizeit/i, 'fa-masks-theater'], [/b2|exam|prüfung|fsp|ausbildung|kurs|schule|school|uni/i, 'fa-graduation-cap'],
      [/versicherung|insurance|haftpflicht|liability/i, 'fa-shield-halved'], [/electronic|elektronik/i, 'fa-plug'], [/stolen|lost|gestohlen|verloren/i, 'fa-mask'],
      [/paper|papier|amt\b|behörde|dokument/i, 'fa-file-lines'], [/saving|spar(en|konto)?\b|rücklage/i, 'fa-piggy-bank'],
      [/sister|schwester|loan|darlehen|repayment|rückzahlung|schuld/i, 'fa-hand-holding-dollar'], [/sperrkonto|allowance|blocked/i, 'fa-building-columns'],
      [/arbeit|gehalt|lohn|salary|job/i, 'fa-briefcase'], [/side income|nebenein|bonus|petty/i, 'fa-coins'], [/mother|mutter|family|familie|eltern/i, 'fa-people-roof'],
      [/friseur|haircut|barber/i, 'fa-scissors'], [/kosmetik|beauty|parfum/i, 'fa-spray-can-sparkles'], [/haustier|pet\b|katze|hund/i, 'fa-paw'],
      [/baby|kind|kita/i, 'fa-baby'], [/kuchen|cake|torte|konditor/i, 'fa-cake-candles'], [/kiosk|büdchen/i, 'fa-store'],
      [/paket|parcel|post\b|versand/i, 'fa-box'], [/spende|zakat|sadaqa|donation/i, 'fa-hand-holding-heart'], [/moschee|mosque/i, 'fa-mosque'],
      [/taxi|uber\b|bolt\b/i, 'fa-taxi'], [/parken|parking|parkhaus/i, 'fa-square-parking'], [/hotel|unterkunft/i, 'fa-hotel'],
      [/eis\b|ice\s*cream|gelato/i, 'fa-ice-cream'], [/getränk|drinks?\b|wasser\s*kiste/i, 'fa-bottle-water'], [/fisch|fish/i, 'fa-fish'],
      [/schmuck|jewel/i, 'fa-gem'], [/müll|trash|abfall/i, 'fa-trash-can'], [/werkzeug|baumarkt|tools?\b|renovier/i, 'fa-hammer'], [/reise|urlaub|travel|flug/i, 'fa-plane'], [/abo\b|subscription/i, 'fa-repeat'], [/sonstig|other|misc/i, 'fa-ellipsis']
    ];
    const GROUP_ICONS = { kids: 'fa-children', housing: 'fa-house', bills: 'fa-file-invoice', subs: 'fa-repeat', insurance: 'fa-shield-halved', groceries: 'fa-basket-shopping',
      household: 'fa-couch', clothing: 'fa-shirt', leisure: 'fa-champagne-glasses', oneoff: 'fa-tag', transport: 'fa-train-subway', health: 'fa-heart-pulse',
      education: 'fa-graduation-cap', fees: 'fa-building-columns', family: 'fa-people-roof' };
    // Brand first (a shop name is most specific), then a keyword symbol; null when nothing matches.
    // Shops, online stores and services common in Germany (NRW), offered when searching for an item.
    const MERCHANTS = [
      ["Aldi Nord", 'groceries', "aldi-nord.de"], ["Aldi Süd", 'groceries', "aldi-sued.de"], ["Lidl", 'groceries', "lidl.de"], ["Rewe", 'groceries', "rewe.de"],
      ["Rewe City", 'groceries', "rewe.de"], ["Edeka", 'groceries', "edeka.de"], ["E center", 'groceries', "edeka.de"], ["Marktkauf", 'groceries', "marktkauf.de"],
      ["Netto", 'groceries', "netto-online.de"], ["Penny", 'groceries', "penny.de"], ["Kaufland", 'groceries', "kaufland.de"], ["HIT", 'groceries', "hit.de"],
      ["Combi", 'groceries', "combi.de"], ["Globus", 'groceries', "globus.de"], ["Norma", 'groceries', "norma-online.de"], ["K+K", 'groceries', "kuk.de"],
      ["nahkauf", 'groceries', "nahkauf.de"], ["Denns BioMarkt", 'groceries', "denns-biomarkt.de"], ["Alnatura", 'groceries', "alnatura.de"], ["basic Bio", 'groceries', "basicbio.de"],
      ["Trinkgut", 'groceries', "trinkgut.de"], ["Getränke Hoffmann", 'groceries', "getraenke-hoffmann.de"], ["Fristo", 'groceries', "fristo.de"], ["Mix Markt", 'groceries', "mixmarkt.eu"],
      ["Asia Markt", 'groceries'], ["Türkischer Markt", 'groceries'], ["Wochenmarkt", 'groceries'], ["Bäckerei", 'groceries'],
      ["Metzgerei", 'groceries'], ["Bäckerei Sommer", 'groceries', "baeckerei-sommer.de", ["sommer", "sommer bäckerei", "sommer backerei", "baeckerei sommer"]],
      ["Bäckerei Büsch", 'groceries', "baeckerei-buesch.de", ["büsch", "busch", "buesch", "busch bäckerei", "backerei busch"]], ["Malzers", 'groceries', "malzers.de", ["malzers backstube"]], ["Kamps", 'groceries', "kamps.de"], ["BackWerk", 'groceries', "back-werk.de"], ["Rewe Lieferservice", 'groceries', "shop.rewe.de"],
      ["Picnic", 'groceries', "picnic.app"], ["Flink", 'groceries', "goflink.com"], ["Knuspr", 'groceries', "knuspr.de"], ["HelloFresh", 'groceries', "hellofresh.de"],
      ["Too Good To Go", 'groceries', "toogoodtogo.com"], ["dm", 'groceries', "dm.de"], ["Rossmann", 'groceries', "rossmann.de"], ["Müller", 'groceries', "mueller.de"],
      ["Apotheke", 'groceries'], ["DocMorris", 'groceries', "docmorris.de"], ["Shop Apotheke", 'groceries', "shop-apotheke.com"], ["Action", 'household', "action.com"],
      ["TEDi", 'household', "tedi.com"], ["KiK", 'clothing|household', "kik.de"], ["Woolworth", 'household', "woolworth.de"], ["KODi", 'household', "kodi.de"],
      ["Tchibo", 'household', "tchibo.de"], ["Depot", 'household', "depot-online.com"], ["Søstrene Grene", 'household', "sostrenegrene.com"], ["Mäc-Geiz", 'household', "maec-geiz.de"],
      ["Thomas Philipps", 'household', "thomas-philipps.de"], ["NKD", 'clothing|household', "nkd.com"], ["Takko", 'clothing|household', "takko.com"], ["Ernsting's family", 'clothing|household', "ernstings-family.de"],
      ["Primark", 'clothing|household', "primark.com"], ["H&M", 'clothing|household', "hm.com"], ["C&A", 'clothing|household', "c-and-a.com"], ["Zara", 'clothing|household', "zara.com"],
      ["New Yorker", 'clothing|household', "newyorker.de"], ["Deichmann", 'clothing|household', "deichmann.com"], ["Snipes", 'clothing|household', "snipes.com"], ["TK Maxx", 'clothing|household', "tkmaxx.de"],
      ["Decathlon", 'household', "decathlon.de"], ["Intersport", 'household', "intersport.de"], ["IKEA", 'household', "ikea.com"], ["Poco", 'household', "poco.de"],
      ["Roller", 'household', "roller.de"], ["XXXLutz", 'household', "xxxlutz.de"], ["Höffner", 'household', "hoeffner.de"], ["porta", 'household', "porta.de"],
      ["Möbel Boss", 'household', "moebel-boss.de"], ["JYSK", 'household', "jysk.de"], ["OBI", 'household', "obi.de"], ["Bauhaus", 'household', "bauhaus.info"],
      ["Hornbach", 'household', "hornbach.de"], ["toom", 'household', "toom.de"], ["hagebaumarkt", 'household', "hagebau.de"], ["MediaMarkt", 'household', "mediamarkt.de"],
      ["Saturn", 'household', "saturn.de"], ["expert", 'household', "expert.de"], ["Euronics", 'household', "euronics.de"], ["Conrad", 'household', "conrad.de"],
      ["Apple Store", 'household', "apple.com"], ["Amazon", 'household', "amazon.de"], ["eBay", 'household', "ebay.de"], ["Kleinanzeigen", 'household', "kleinanzeigen.de"],
      ["Zalando", 'household', "zalando.de"], ["Otto", 'household', "otto.de"], ["Temu", 'household', "temu.com"], ["Shein", 'household', "shein.com"],
      ["AliExpress", 'household', "aliexpress.com"], ["About You", 'household', "aboutyou.de"], ["Vinted", 'household', "vinted.de"], ["Etsy", 'household', "etsy.com"],
      ["PayPal", 'household', "paypal.com"], ["Klarna", 'household', "klarna.com"], ["DHL", 'household', "dhl.de"], ["Deutsche Post", 'household', "deutschepost.de"],
      ["Hermes", 'household', "myhermes.de"], ["DPD", 'household', "dpd.com"], ["GLS", 'household', "gls-pakete.de"], ["UPS", 'household', "ups.com"],
      ["McDonald's", 'leisure', "mcdonalds.de"], ["Burger King", 'leisure', "burgerking.de"], ["KFC", 'leisure', "kfc.de"], ["Subway", 'leisure', "subway.com"],
      ["Domino's", 'leisure', "dominos.de"], ["Pizza Hut", 'leisure', "pizzahut.de"], ["Starbucks", 'leisure', "starbucks.de"], ["Dunkin'", 'leisure', "dunkin.de"],
      ["Vapiano", 'leisure', "vapiano.de"], ["Nordsee", 'leisure', "nordsee.com"], ["Lieferando", 'leisure', "lieferando.de"], ["Wolt", 'leisure', "wolt.com"],
      ["Uber Eats", 'leisure', "ubereats.com"], ["Dönerladen", 'leisure'], ["Restaurant", 'leisure'], ["Café", 'leisure'],
      ["Kino", 'leisure'], ["CinemaxX", 'leisure', "cinemaxx.de"], ["UCI Kinowelt", 'leisure', "uci-kinowelt.de"], ["Eventim", 'leisure', "eventim.de"],
      ["Thalia", 'leisure', "thalia.de"], ["Mayersche", 'leisure', "mayersche.de"], ["Deutsche Bahn", 'transport', "bahn.de"], ["Deutschlandticket", 'transport', "bahn.de"],
      ["Rheinbahn", 'transport', "rheinbahn.de"], ["KVB", 'transport', "kvb.koeln"], ["Ruhrbahn", 'transport', "ruhrbahn.de"], ["BOGESTRA", 'transport', "bogestra.de"],
      ["DSW21", 'transport', "dsw21.de"], ["VRR", 'transport', "vrr.de"], ["FlixBus", 'transport', "flixbus.de"], ["Uber", 'transport', "uber.com"],
      ["Bolt", 'transport', "bolt.eu"], ["FreeNow", 'transport', "free-now.com"], ["Tier", 'transport', "tier.app"], ["Lime", 'transport', "li.me"],
      ["Aral", 'transport', "aral.de"], ["Shell", 'transport', "shell.de"], ["Esso", 'transport', "esso.de"], ["JET", 'transport', "jet-tankstellen.de"],
      ["TotalEnergies", 'transport', "totalenergies.de"], ["Netflix", 'subs', "netflix.com"], ["Spotify", 'subs', "spotify.com"], ["Disney+", 'subs', "disneyplus.com"],
      ["Amazon Prime", 'subs', "amazon.de"], ["YouTube Premium", 'subs', "youtube.com"], ["Apple iCloud", 'subs', "apple.com"], ["Google One", 'subs', "one.google.com"],
      ["DAZN", 'subs', "dazn.com"], ["Sky", 'subs', "sky.de"], ["WOW", 'subs', "wowtv.de"], ["Audible", 'subs', "audible.de"],
      ["ChatGPT", 'subs', "openai.com"], ["Claude", 'subs', "claude.ai"], ["Microsoft 365", 'subs', "microsoft.com"], ["Adobe", 'subs', "adobe.com"],
      ["PlayStation Plus", 'subs', "playstation.com"], ["Xbox Game Pass", 'subs', "xbox.com"], ["Telekom", 'bills', "telekom.de"], ["Vodafone", 'bills', "vodafone.de"],
      ["O2", 'bills', "o2online.de"], ["1&1", 'bills', "1und1.de"], ["congstar", 'bills', "congstar.de"], ["Aldi Talk", 'bills', "alditalk.de"],
      ["Lidl Connect", 'bills', "lidl-connect.de"], ["fraenk", 'bills', "fraenk.de"], ["Rundfunkbeitrag", 'bills', "rundfunkbeitrag.de"], ["Stadtwerke", 'bills'],
      ["E.ON", 'bills', "eon.de"], ["RWE", 'bills', "rwe.com"], ["EnBW", 'bills', "enbw.com"], ["Vattenfall", 'bills', "vattenfall.de"],
      ["Tibber", 'bills', "tibber.com"], ["Octopus Energy", 'bills', "octopusenergy.de"], ["AOK", 'insurance', "aok.de"], ["TK Techniker", 'insurance', "tk.de"],
      ["Barmer", 'insurance', "barmer.de"], ["DAK", 'insurance', "dak.de"], ["IKK", 'insurance', "ikk-classic.de"], ["HUK-Coburg", 'insurance', "huk.de"],
      ["Allianz", 'insurance', "allianz.de"], ["Die Haftpflichtkasse", 'insurance', "haftpflichtkasse.de", ["haftpflichtkasse", "haftpflicht kasse"]], ["AXA", 'insurance', "axa.de"], ["ERGO", 'insurance', "ergo.de"], ["Check24", 'insurance', "check24.de"],
      ["Care Concept", 'insurance', "care-concept.de"], ["Gold's Gym", 'health|leisure', "goldsgym.de", ["golds gym", "gold's", "goldsgym"]], ["John Reed", 'health|leisure', "johnreed.fitness"], ["Kieser Training", 'health|leisure', "kieser.com", ["kieser"]], ["Mrs.Sporty", 'health|leisure', "mrssporty.de", ["mrs sporty"]], ["EasyFit", 'health|leisure', "easyfit.de", ["easy fit"]], ["Fit Star", 'health|leisure', "fit-star.de", ["fitstar"]], ["Holmes Place", 'health|leisure', "holmesplace.de"], ["Ai Fitness", 'health|leisure', "aifitness.de"], ["McFit", 'health', "mcfit.com"], ["FitX", 'health', "fitx.de"], ["Fitness First", 'health', "fitnessfirst.de"],
      ["clever fit", 'health', "clever-fit.com"], ["Urban Sports Club", 'health', "urbansportsclub.com"], ["Arzt", 'health'], ["Zahnarzt", 'health'],
      ["Optiker", 'health'], ["Fielmann", 'health', "fielmann.de"], ["Sparkasse", 'fees', "sparkasse.de"], ["Volksbank", 'fees', "vr.de"],
      ["Revolut", 'fees', "revolut.com"], ["Wise", 'fees', "wise.com"], ["N26", 'fees', "n26.com"], ["ING", 'fees', "ing.de"],
      ["Commerzbank", 'fees', "commerzbank.de"], ["Deutsche Bank", 'fees', "deutsche-bank.de"], ["Postbank", 'fees', "postbank.de"], ["Western Union", 'fees', "westernunion.com"],
      ["Ria", 'fees', "riamoneytransfer.com"],
      // Everyday life in NRW beyond shops: childcare, offices, car, leisure, pets, health – and incomes.
      ["Kita-Beitrag", 'kids|family|education|oneoff', null, ["kita", "keta", "kindergarten", "kiga", "kindertagesstätte", "روضة"]], ["Kita Essensgeld", 'kids|family|education|oneoff', null, ["kita", "keta", "mittagessen"]], ["Tagesmutter", 'kids|family|education|oneoff', null, ["tagespflege", "kinderbetreuung"]],
      ["OGS", 'kids|family|education|oneoff', null, ["offene ganztagsschule", "ganztag"]], ["Schulessen", 'kids|family|education|oneoff', null, ["mensa", "mittagessen schule"]], ["Schulbedarf", 'kids|family|education|oneoff', null, ["schulsachen", "hefte", "ranzen"]],
      ["Klassenfahrt", 'kids|family|education|oneoff', null, ["ausflug schule"]], ["Babysitter", 'kids|family|education|oneoff', null, []], ["Windeln", 'kids|family|education|oneoff', null, ["pampers", "diapers"]],
      ["Babynahrung", 'kids|family|education|oneoff', null, ["hipp", "milupa", "aptamil"]], ["Kinderkleidung", 'clothing|kids|family|household', null, []], ["Spielzeug", 'kids|family|education|oneoff', null, ["toys", "spielwaren"]],
      ["Smyths Toys", 'kids|family|education|oneoff', "smythstoys.com", ["spielwaren"]], ["myToys", 'kids|family|education|oneoff', "mytoys.de", []], ["BabyOne", 'kids|family|education|oneoff', "babyone.de", ["baby"]],
      ["Kinderarzt", 'kids|family|education|oneoff', null, ["pädiater"]], ["Musikschule", 'kids|family|education|oneoff', null, []], ["Schwimmkurs", 'kids|family|education|oneoff', null, []],
      ["Bürgeramt", 'oneoff|bills', null, ["ausweis", "pass", "meldebescheinigung"]], ["Ausländerbehörde", 'oneoff|bills', null, ["aufenthaltstitel", "visum", "eat"]], ["Standesamt", 'oneoff|bills', null, ["urkunde", "heirat"]],
      ["Führerschein", 'oneoff|bills', null, ["fahrschule"]], ["Übersetzung", 'oneoff|bills', null, ["übersetzer", "beglaubigung"]], ["Notar", 'oneoff|bills', null, []],
      ["Anwalt", 'oneoff|bills', null, ["rechtsanwalt"]], ["Steuerberater", 'oneoff|bills', null, ["lohnsteuerhilfe"]], ["Umzug", 'oneoff|bills', null, ["umzugskarton", "transporter"]],
      ["Handwerker", 'oneoff|bills', null, []], ["Schlüsseldienst", 'oneoff|bills', null, []], ["Copyshop", 'oneoff|bills', null, ["kopien", "drucken"]],
      ["Passfotos", 'oneoff|bills', null, ["foto"]], ["Nebenkosten", 'bills|housing', null, ["betriebskosten", "nachzahlung"]], ["Hausgeld", 'bills|housing', null, []],
      ["Wasser", 'bills|housing', null, ["stadtwerke wasser"]], ["Müllgebühren", 'bills|housing', null, ["abfall"]], ["Kfz-Steuer", 'bills|housing', null, ["auto steuer"]],
      ["GEZ", 'bills|housing', null, ["rundfunk", "ard zdf"]], ["Parken", 'transport', null, ["parkhaus", "parkticket", "contipark"]], ["Waschanlage", 'transport', null, ["autowäsche"]],
      ["Werkstatt", 'transport', null, ["reparatur", "tüv"]], ["A.T.U", 'transport', "atu.de", ["reifen"]], ["ADAC", 'transport', "adac.de", []],
      ["TÜV", 'transport', null, ["hu", "dekra"]], ["Fahrrad", 'transport', null, ["fahrradladen", "rad"]], ["Ryanair", 'transport', "ryanair.com", ["flug"]],
      ["Eurowings", 'transport', "eurowings.com", ["flug"]], ["Lufthansa", 'transport', "lufthansa.com", ["flug"]], ["Turkish Airlines", 'transport', "turkishairlines.com", ["flug"]],
      ["Pegasus", 'transport', "flypgs.com", ["flug"]], ["FlixTrain", 'transport', "flixtrain.de", []], ["BlaBlaCar", 'transport', "blablacar.de", []],
      ["Sixt", 'transport', "sixt.de", ["mietwagen"]], ["Share Now", 'transport', "share-now.com", ["carsharing"]], ["Miles", 'transport', "miles-mobility.com", ["carsharing"]],
      ["Booking.com", 'leisure', "booking.com", ["hotel"]], ["Airbnb", 'leisure', "airbnb.de", ["urlaub"]], ["Hotel", 'leisure', null, []],
      ["Phantasialand", 'leisure', "phantasialand.de", ["freizeitpark"]], ["Movie Park", 'leisure', "movieparkgermany.de", ["freizeitpark"]], ["Zoo", 'leisure', null, ["tierpark"]],
      ["Schwimmbad", 'leisure', null, ["hallenbad", "freibad"]], ["Museum", 'leisure', null, []], ["Bowling", 'leisure', null, []],
      ["Shisha Bar", 'leisure', null, ["shisha"]], ["Kiosk", 'leisure', null, ["trinkhalle", "büdchen"]], ["Lotto", 'leisure', null, ["lottoannahme"]],
      ["Friseur", 'leisure', null, ["barbier", "barber", "haare"]], ["Geschenke", 'leisure', null, ["geschenk"]], ["Blumen", 'leisure', null, ["blumenladen"]],
      ["Spende", 'leisure', null, ["zakat", "sadaqa", "donation"]], ["Moschee", 'leisure', null, ["mosque"]], ["Kirche", 'leisure', null, []],
      ["Verein", 'leisure', null, ["mitgliedsbeitrag", "sportverein"]], ["Steam", 'leisure', "steampowered.com", ["games"]], ["Galeria", 'leisure', "galeria.de", ["kaufhof", "karstadt"]],
      
      ["Jack & Jones", 'clothing|household', "jackjones.com", ["jack and jones", "jack&jones", "jack jones", "jackjones", "j&j"]], ["Only", 'clothing|household', "only.com", ["only store"]], ["Vero Moda", 'clothing|household', "veromoda.com", ["veromoda"]], ["s.Oliver", 'clothing|household', "soliver.de", ["s oliver", "soliver"]], ["Esprit", 'clothing|household', "esprit.de"], ["Tom Tailor", 'clothing|household', "tom-tailor.de", ["tomtailor"]], ["Mango", 'clothing|household', "mango.com"], ["Bershka", 'clothing|household', "bershka.com"], ["Pull&Bear", 'clothing|household', "pullandbear.com", ["pull and bear", "pull & bear"]], ["Stradivarius", 'clothing|household', "stradivarius.com"], ["Massimo Dutti", 'clothing|household', "massimodutti.com"], ["Zara Home", 'clothing|household', "zarahome.com"], ["COS", 'clothing|household', "cos.com", ["cos store"]], ["Reserved", 'clothing|household', "reserved.com"], ["Sinsay", 'clothing|household', "sinsay.com"], ["Pepco", 'clothing|household', "pepco.de"], ["Uniqlo", 'clothing|household', "uniqlo.com"], ["Asos", 'clothing|household', "asos.com"], ["Bonprix", 'clothing|household', "bonprix.de"], ["Orsay", 'clothing|household', "orsay.com"], ["Gina Tricot", 'clothing|household', "ginatricot.com"], ["Calzedonia", 'clothing|household', "calzedonia.com"], ["Intimissimi", 'clothing|household', "intimissimi.com"], ["Tezenis", 'clothing|household', "tezenis.com"], ["Hunkemöller", 'clothing|household', "hunkemoller.de", ["hunkemoller", "hunkemoeller"]], ["Hollister", 'clothing|household', "hollisterco.com"], ["Abercrombie & Fitch", 'clothing|household', "abercrombie.com", ["abercrombie"]], ["Levi's", 'clothing|household', "levi.com", ["levis", "levi"]], ["Tommy Hilfiger", 'clothing|household', "tommy.com", ["tommy"]], ["Calvin Klein", 'clothing|household', "calvinklein.de"], ["Hugo Boss", 'clothing|household', "hugoboss.com", ["boss", "hugo"]], ["Lacoste", 'clothing|household', "lacoste.com"], ["Superdry", 'clothing|household', "superdry.de"], ["Breuninger", 'clothing|household', "breuninger.com"], ["Jack Wolfskin", 'clothing|household', "jack-wolfskin.de", ["wolfskin"]], ["Nike", 'clothing|household', "nike.com"], ["Adidas", 'clothing|household', "adidas.de"], ["Puma", 'clothing|household', "puma.com"], ["Foot Locker", 'clothing|household', "footlocker.de", ["footlocker"]], ["JD Sports", 'clothing|household', "jdsports.de", ["jd"]], ["SportScheck", 'clothing|household', "sportscheck.com", ["sport scheck"]], ["Görtz", 'clothing|household', "goertz.de", ["goertz"]], ["Skechers", 'clothing|household', "skechers.de"], ["New Balance", 'clothing|household', "newbalance.de"], ["Flying Tiger", 'household', "flyingtiger.com", ["tiger"]], ["Nanu-Nana", 'household', "nanu-nana.de", ["nanu nana"]], ["Lush", 'household', "lush.com"], ["Rituals", 'household', "rituals.com"], ["The Body Shop", 'household', "thebodyshop.com", ["body shop"]], ["Lego", 'household', "lego.com"], ["Gravis", 'household', "gravis.de"], ["Samsung", 'household', "samsung.com"], ["Xiaomi", 'household', "mi.com", ["mi store"]],
      ["Peek & Cloppenburg", 'leisure', "peek-cloppenburg.de", []], ["Douglas", 'leisure', "douglas.de", ["parfüm"]], ["Bijou Brigitte", 'leisure', "bijou-brigitte.com", []],
      ["Fressnapf", 'household', "fressnapf.de", ["tierfutter"]], ["Das Futterhaus", 'household', "futterhaus.de", ["tierfutter"]], ["Zooplus", 'household', "zooplus.de", ["tierfutter"]],
      ["Tierarzt", 'household', null, ["vet"]], ["Waschsalon", 'household', null, ["wäsche"]], ["Reinigung", 'household', null, ["textilreinigung"]],
      ["Schneiderei", 'household', null, ["änderung"]], ["Schuster", 'household', null, ["schuhreparatur"]], ["Handyreparatur", 'household', null, ["display"]],
      ["Cyberport", 'household', "cyberport.de", []], ["notebooksbilliger", 'household', "notebooksbilliger.de", []], ["Galaxus", 'household', "galaxus.de", []],
      ["Mister Spex", 'household', "misterspex.de", ["brille"]], ["Apollo Optik", 'household', "apollo.de", ["brille"]], ["Dänisches Bettenlager", 'household', "jysk.de", ["jysk"]],
      ["Hammer", 'household', "hammer-zuhause.de", ["heimtex"]], ["Möbel Höffner", 'household', "hoeffner.de", []], ["Matratze", 'household', null, []],
      ["Haushaltsgeräte", 'household', null, ["waschmaschine", "kühlschrank"]], ["Physiotherapie", 'health|groceries', null, ["physio", "krankengymnastik"]], ["Krankenhaus", 'health|groceries', null, ["zuzahlung"]],
      ["Hausarzt", 'health|groceries', null, ["arzt"]], ["Frauenarzt", 'health|groceries', null, ["gynäkologe"]], ["Hebamme", 'health|groceries', null, []],
      ["Medikamente", 'health|groceries', null, ["rezept", "zuzahlung"]], ["Gehalt", 'income', null, ["lohn", "salary", "راتب"]], ["Kindergeld", 'income', null, ["familienkasse"]],
      ["Elterngeld", 'income', null, []], ["Kinderzuschlag", 'income', null, ["kiz"]], ["Wohngeld", 'income', null, []],
      ["Bürgergeld", 'income', null, ["jobcenter"]], ["BAföG", 'income', null, ["bafög"]], ["Minijob", 'income', null, ["520", "nebenjob"]],
      ["Werkstudent", 'income', null, []], ["Arbeitslosengeld", 'income', null, ["alg", "agentur für arbeit"]], ["Krankengeld", 'income', null, []],
      ["Mutterschaftsgeld", 'income', null, []], ["Steuererstattung", 'income', null, ["finanzamt", "steuer zurück"]], ["Rückerstattung", 'income', null, ["erstattung", "refund"]],
      ["Pfand", 'income', null, ["leergut"]], ["Verkauf Kleinanzeigen", 'income', null, ["kleinanzeigen", "vinted"]], ["Geschenk erhalten", 'income', null, ["geld geschenk"]],
      ["Sperrkonto", 'income', null, ["fintiba", "expatrio", "coracle"]], ["Stipendium", 'income', null, ["daad"]], ["Zinsen", 'income', null, ["interest"]]
    ];
    // Short explanations shown when a suggestion is picked: [German, English, Arabic].
    const GROUP_INFO = {"groceries": ["Lebensmittel, Getränke oder Drogerie – Supermarkt, Discounter, Drogeriemarkt oder Lieferdienst.", "Food, drinks or drugstore items – a supermarket, discounter, drugstore or delivery service.", "طعام أو مشروبات أو مستلزمات صيدلية/عناية – سوبرماركت أو محل مخفّض أو دروغري أو خدمة توصيل."], "household": ["Haushalt, Kleidung, Möbel, Elektronik oder Online-Shopping, auch Paketdienste.", "Household goods, clothes, furniture, electronics or online shopping, including parcel services.", "أدوات منزلية أو ملابس أو أثاث أو إلكترونيات أو تسوق إلكتروني، وكذلك شركات الطرود."], "leisure": ["Essen gehen, Freizeit, Ausflüge, Urlaub und Persönliches.", "Eating out, free time, trips, holidays and personal things.", "الأكل خارج البيت والترفيه والرحلات والعطلات والأمور الشخصية."], "transport": ["Bus, Bahn, Taxi, Auto, Tanken, Flüge und alles rund ums Unterwegssein.", "Bus, train, taxi, car, fuel, flights – everything about getting around.", "الباص والقطار والتاكسي والسيارة والوقود والطيران – كل ما يخص التنقل."], "subs": ["Ein Abo, das jeden Monat oder jedes Jahr automatisch abgebucht wird.", "A subscription that is charged automatically every month or year.", "اشتراك يُخصم تلقائيًا كل شهر أو كل سنة."], "bills": ["Eine feste Rechnung: Telefon, Internet, Strom, Gas oder Gebühren für die Wohnung.", "A regular bill: phone, internet, electricity, gas or charges for the flat.", "فاتورة ثابتة: هاتف أو إنترنت أو كهرباء أو غاز أو رسوم السكن."], "insurance": ["Eine Krankenkasse oder Versicherung.", "A health insurer or another insurance.", "تأمين صحي (Krankenkasse) أو تأمين آخر."], "health": ["Gesundheit und Sport: Ärzte, Therapie, Fitnessstudio, Brillen.", "Health and sport: doctors, therapy, gym, glasses.", "الصحة والرياضة: أطباء وعلاج ونادي رياضي ونظارات."], "fees": ["Eine Bank oder ein Dienst für Geldüberweisungen – meist Kontogebühren.", "A bank or money-transfer service – usually account fees.", "بنك أو خدمة تحويل أموال – غالبًا رسوم الحساب."], "kids": ["Kosten für Kinder: Betreuung, Schule, Kleidung, Spielzeug.", "Costs for children: childcare, school, clothes, toys.", "تكاليف الأطفال: الرعاية والمدرسة والملابس والألعاب."], "oneoff": ["Amt, Papiere oder eine Dienstleistung – meist eine einmalige Ausgabe.", "Office, paperwork or a service – usually a one-time cost.", "دائرة حكومية أو أوراق أو خدمة – غالبًا مصروف لمرة واحدة."], "income": ["Geld, das reinkommt.", "Money coming in.", "مال وارد."]};
    const MERCHANT_INFO = {"Kita-Beitrag": ["Monatlicher Elternbeitrag für die Kita (Kindertagesstätte). Die Höhe legt die Stadt nach Einkommen fest; in NRW sind die letzten zwei Kita-Jahre vor der Schule beitragsfrei.", "Monthly parents' fee for the Kita (daycare/kindergarten). The city sets it by income; in NRW the last two Kita years before school are free.", "الرسوم الشهرية للروضة (Kita). تحددها البلدية حسب الدخل، وفي ولاية NRW تكون آخر سنتين قبل المدرسة مجانيتين."], "Kita Essensgeld": ["Geld für das Mittagessen in der Kita, zusätzlich zum Elternbeitrag.", "Money for lunch at the Kita, on top of the parents' fee.", "مبلغ وجبة الغداء في الروضة، إضافة إلى الرسوم الشهرية."], "Tagesmutter": ["Kinderbetreuung bei einer Tagesmutter/einem Tagesvater (Kindertagespflege), oft für Kinder unter 3.", "Childcare by a registered childminder (Kindertagespflege), often for children under 3.", "رعاية الطفل عند مربية معتمدة في بيتها، غالبًا للأطفال تحت 3 سنوات."], "OGS": ["Offene Ganztagsschule: Betreuung nach dem Unterricht in der Grundschule, mit Elternbeitrag.", "Open all-day school: afternoon care at primary school, with a parents' fee.", "الرعاية بعد الدوام في المدرسة الابتدائية (OGS)، برسوم شهرية."], "Schulessen": ["Mittagessen in der Schule (Mensa).", "Lunch at school (canteen).", "وجبة الغداء في المدرسة."], "Schulbedarf": ["Hefte, Stifte, Ranzen und andere Schulsachen.", "Notebooks, pens, school bag and other school things.", "دفاتر وأقلام وحقيبة ومستلزمات مدرسية."], "Klassenfahrt": ["Ausflug oder Reise mit der Schulklasse.", "A school trip with the class.", "رحلة مدرسية مع الصف."], "Windeln": ["Windeln für das Baby.", "Nappies/diapers for the baby.", "حفاضات للطفل."], "Babynahrung": ["Milch, Brei und Gläschen für das Baby.", "Formula, porridge and jars for the baby.", "حليب وأطعمة الأطفال."], "Kinderarzt": ["Kinderärztin/Kinderarzt – Kosten fallen meist nur für Extras an.", "Paediatrician – usually costs only for extras.", "طبيب أطفال – غالبًا تكاليف إضافية فقط."], "Bürgeramt": ["Amt der Stadt für Ausweis, Reisepass, Anmeldung der Wohnung und Bescheinigungen.", "City office for ID card, passport, registering your address and certificates.", "دائرة البلدية للهوية وجواز السفر وتسجيل السكن والشهادات."], "Ausländerbehörde": ["Amt für Aufenthaltstitel und Visa; Gebühren z. B. für den elektronischen Aufenthaltstitel (eAT).", "Immigration office for residence permits and visas; fees e.g. for the electronic residence card (eAT).", "دائرة الأجانب للإقامات والفيز؛ رسوم مثل بطاقة الإقامة الإلكترونية (eAT)."], "Standesamt": ["Amt für Geburt, Ehe und Urkunden.", "Registry office for births, marriages and certificates.", "دائرة الأحوال المدنية للولادة والزواج والوثائق."], "Führerschein": ["Fahrschule, Prüfung oder Umschreibung des Führerscheins.", "Driving school, test or converting a driving licence.", "مدرسة القيادة أو الامتحان أو تبديل رخصة القيادة."], "Übersetzung": ["Beglaubigte Übersetzung von Dokumenten.", "Certified translation of documents.", "ترجمة محلفة للوثائق."], "Notar": ["Notar für Beglaubigungen und Verträge.", "Notary for certifications and contracts.", "كاتب عدل للتصديقات والعقود."], "Steuerberater": ["Hilfe bei der Steuererklärung (Steuerberater oder Lohnsteuerhilfeverein).", "Help with the tax return (tax adviser or tax-help association).", "مساعدة في التصريح الضريبي (مستشار ضريبي أو جمعية مساعدة ضريبية)."], "Nebenkosten": ["Betriebskosten der Wohnung (Heizung, Wasser, Müll …); oft eine Nachzahlung einmal im Jahr.", "Running costs of the flat (heating, water, rubbish …); often a back-payment once a year.", "تكاليف تشغيل السكن (تدفئة، ماء، قمامة …)؛ غالبًا دفعة تسوية مرة في السنة."], "Müllgebühren": ["Gebühren der Stadt für die Müllabfuhr.", "City charges for rubbish collection.", "رسوم البلدية لجمع القمامة."], "Kfz-Steuer": ["Jährliche Steuer für das Auto.", "Yearly tax for the car.", "ضريبة السيارة السنوية."], "GEZ": ["Rundfunkbeitrag (früher GEZ): ein fester Betrag pro Wohnung, meist vierteljährlich bezahlt – Pflicht für jede Wohnung.", "Broadcasting fee (formerly GEZ): a fixed amount per household, usually paid quarterly – required for every home.", "رسوم البث (GEZ سابقًا): مبلغ ثابت لكل سكن، تُدفع غالبًا كل 3 أشهر – إلزامية لكل بيت."], "Rundfunkbeitrag": ["Rundfunkbeitrag (früher GEZ): ein fester Betrag pro Wohnung, meist vierteljährlich bezahlt – Pflicht für jede Wohnung.", "Broadcasting fee (formerly GEZ): a fixed amount per household, usually paid quarterly – required for every home.", "رسوم البث (GEZ سابقًا): مبلغ ثابت لكل سكن، تُدفع غالبًا كل 3 أشهر – إلزامية لكل بيت."], "Deutschlandticket": ["Monatsticket für Bus und Regionalbahn in ganz Deutschland (Abo).", "Monthly ticket for buses and regional trains all over Germany (subscription).", "تذكرة شهرية للباصات والقطارات الإقليمية في كل ألمانيا (اشتراك)."], "VRR": ["Verkehrsverbund Rhein-Ruhr: Tickets für Bus und Bahn im Ruhrgebiet und am Niederrhein.", "Rhine-Ruhr transport association: bus and train tickets in the Ruhr area.", "شبكة مواصلات الراين-الرور: تذاكر الباص والقطار في منطقة الرور."], "TÜV": ["Hauptuntersuchung des Autos (alle 2 Jahre), auch bei DEKRA.", "Vehicle safety inspection (every 2 years), also at DEKRA.", "الفحص الدوري للسيارة (كل سنتين)، أيضًا عند DEKRA."], "ADAC": ["Automobilclub: Pannenhilfe und Versicherungen, Mitgliedsbeitrag pro Jahr.", "Automobile club: breakdown help and insurance, yearly membership fee.", "نادي السيارات: مساعدة الأعطال والتأمين، باشتراك سنوي."], "Kiosk": ["Kiosk/Büdchen: Getränke, Snacks, Zeitungen – typisch fürs Ruhrgebiet.", "Corner shop (Büdchen): drinks, snacks, newspapers – typical in the Ruhr area.", "كشك (Büdchen): مشروبات وسناكات وجرائد – شائع في منطقة الرور."], "Pfand": ["Pfand zurück für Flaschen und Dosen (Leergut).", "Deposit returned for bottles and cans.", "استرجاع عربون العبوات والزجاجات (Pfand)."], "Spende": ["Spende, Zakat oder Sadaqa.", "Donation, zakat or sadaqa.", "تبرع أو زكاة أو صدقة."], "Verein": ["Mitgliedsbeitrag für einen Verein, z. B. Sportverein.", "Membership fee for a club, e.g. a sports club.", "اشتراك في نادٍ أو جمعية، مثل النادي الرياضي."], "Physiotherapie": ["Krankengymnastik; meist 10 € pro Rezept plus 10 % Zuzahlung.", "Physiotherapy; usually €10 per prescription plus 10 % co-payment.", "العلاج الفيزيائي؛ غالبًا 10 € للوصفة إضافة إلى 10 % مساهمة."], "Medikamente": ["Zuzahlung in der Apotheke: 5–10 € pro Medikament auf Rezept.", "Co-payment at the pharmacy: €5–10 per prescribed medicine.", "المساهمة في الصيدلية: 5–10 € لكل دواء بوصفة."], "Hebamme": ["Hebamme vor und nach der Geburt – meist von der Krankenkasse bezahlt.", "Midwife before and after birth – usually paid by health insurance.", "القابلة قبل الولادة وبعدها – غالبًا يدفعها التأمين الصحي."], "Gehalt": ["Lohn oder Gehalt von der Arbeit.", "Wages or salary from work.", "الراتب أو الأجر من العمل."], "Kindergeld": ["Von der Familienkasse, monatlich pro Kind – zu beantragen nach der Geburt.", "From the Familienkasse, monthly per child – apply after the birth.", "من صندوق العائلة (Familienkasse)، شهريًا لكل طفل – يُطلب بعد الولادة."], "Elterngeld": ["Geld vom Staat nach der Geburt, wenn ein Elternteil weniger arbeitet – meist 65–67 % des Nettoeinkommens.", "State money after a birth while a parent works less – usually 65–67 % of net income.", "مال من الدولة بعد الولادة عند تقليل العمل – غالبًا 65–67 % من صافي الدخل."], "Kinderzuschlag": ["Zusatz zum Kindergeld für Familien mit kleinem Einkommen (Familienkasse).", "Extra on top of child benefit for low-income families (Familienkasse).", "إضافة إلى Kindergeld للعائلات ذات الدخل المحدود."], "Wohngeld": ["Zuschuss zur Miete von der Stadt bei kleinem Einkommen.", "Housing benefit from the city for low incomes.", "دعم الإيجار من البلدية لأصحاب الدخل المحدود."], "Bürgergeld": ["Grundsicherung vom Jobcenter.", "Basic income support from the Jobcenter.", "المساعدة الأساسية من الجوب سنتر."], "BAföG": ["Förderung für Studium oder Ausbildung.", "State support for studies or training.", "دعم الدولة للدراسة أو التدريب المهني."], "Minijob": ["Nebenjob mit kleinem Verdienst bis zur Minijob-Grenze, meist ohne Steuern.", "Side job with small earnings up to the minijob limit, usually without tax.", "عمل جانبي بدخل صغير حتى حد الميني جوب، غالبًا بدون ضريبة."], "Steuererstattung": ["Geld vom Finanzamt nach der Steuererklärung.", "Money back from the tax office after the tax return.", "مال مسترد من مكتب الضرائب بعد التصريح الضريبي."], "Sperrkonto": ["Monatliche Auszahlung vom Sperrkonto (z. B. Fintiba, Expatrio).", "Monthly payout from a blocked account (e.g. Fintiba, Expatrio).", "الدفعة الشهرية من الحساب المجمد (مثل Fintiba وExpatrio)."], "Arbeitslosengeld": ["Geld von der Agentur für Arbeit nach Jobverlust.", "Unemployment benefit from the employment agency.", "إعانة البطالة من وكالة العمل."], "Check24": ["Vergleichsportal für Versicherungen, Strom, Handy und Kredite.", "Comparison site for insurance, energy, mobile and loans.", "موقع مقارنة للتأمين والكهرباء والهاتف والقروض."], "Care Concept": ["Krankenversicherung für Studierende, Gäste und Sprachschüler.", "Health insurance for students, visitors and language learners.", "تأمين صحي للطلاب والزوار وطلاب اللغة."]};
    // Entries: [name, group (alternatives split by |, the first one the household has wins), website for the logo, other words people type].
    const merchantMatch = (q, have, type = 'expenses') => {
      const n = q.trim().toLowerCase();
      if (!n) return [];
      const known = new Set(have.map(x => x.toLowerCase()));
      const words = (e) => [e[0], ...(e[3] || [])].map(w => w.toLowerCase());
      const starts = (e) => words(e).some(w => w.startsWith(n)) ? 1 : 0;
      return MERCHANTS.filter(e => (type === 'incomes') === (e[1] === 'income') && !known.has(e[0].toLowerCase()) && words(e).some(w => w.includes(n)))
        .sort((a, b) => starts(b) - starts(a) || a[0].localeCompare(b[0]));
    };
    const resolveGroup = (groups, gid) => (gid || '').split('|').map(id => groups.find(g => g.id === id)
      || (id === 'clothing' ? groups.find(g => g.kind !== 'fixed' && CLOTHES_RE.test(g.name || '')) : null)).find(Boolean)
      || groups.find(g => g.kind === 'variable') || groups[0];
    // Every shop in the directory that has a website: its name or an alias as a whole word gives its logo
    // (falls back to its initials when the logo can't load). Longest names first, so "Rewe City" beats "Rewe".
    const MERCHANT_LOGOS = (() => {
      const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const list = [];
      MERCHANTS.forEach(e => { if (!e[2]) return; [e[0], ...(e[3] || [])].forEach(w => { if (w.length >= 3) list.push([w, e]); }); });
      list.sort((a, b) => b[0].length - a[0].length);
      return list.map(([w, e]) => [new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, 'iu'), e]);
    })();
    const merchantLogoFor = (n) => {
      const hit = MERCHANT_LOGOS.find(([re]) => re.test(n));
      if (!hit) return null;
      const e = hit[1];
      const text = e[0].replace(/^(bäckerei|die|der|das)\s+/i, '').split(/[\s-]+/).filter(x => /\p{L}|\p{N}/u.test(x)).map(x => x.match(/[\p{L}\p{N}]/u)[0]).join('').slice(0, 2).toUpperCase();
      return { kind: 'brand', text, bg: '#334155', fg: '#FFFFFF', logo: 'web:' + e[2] };
    };
    // Logos to choose from for a search text (brand badges first, then directory shops with a website).
    const logoOptions = (q) => {
      const n = String(q || '').trim();
      if (n.length < 2) return [];
      const out = [], seen = new Set();
      const add = (label, spec) => { const k = spec.logo || spec.text + spec.bg; if (!seen.has(k)) { seen.add(k); out.push({ label, spec }); } };
      BRANDS.forEach(b => { const mt = n.match(b[0]); if (mt) add(mt[0].trim().replace(/^\w/, c => c.toUpperCase()) || b[1], { kind: 'brand', text: b[1], bg: b[2], fg: b[3], ...(b[4] ? { logo: b[4] } : {}) }); });
      const low = n.toLowerCase();
      const hit = MERCHANT_LOGOS.find(([re]) => re.test(n));
      if (hit) add(hit[1][0], merchantLogoFor(hit[1][0]));
      MERCHANTS.filter(e => e[2] && [e[0], ...(e[3] || [])].some(w => w.toLowerCase().includes(low) || low.includes(w.toLowerCase()) && w.length >= 3))
        .slice(0, 16).forEach(e => { const sp = merchantLogoFor(e[0]); if (sp) add(e[0], sp); });
      const dom = n.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(dom)) add(dom, { kind: 'brand', text: dom[0].toUpperCase(), bg: '#334155', fg: '#FFFFFF', logo: 'web:' + dom });
      return out.slice(0, 12);
    };
    const autoIcon = (name) => {
      const n = String(name || '');
      const b = BRANDS.find(([re]) => re.test(n));
      if (b) return { kind: 'brand', text: b[1], bg: b[2], fg: b[3], ...(b[4] ? { logo: b[4] } : {}) };
      const m = merchantLogoFor(n);
      if (m) return m;
      const k = KEYWORD_ICONS.find(([re]) => re.test(n));
      return k ? { kind: 'symbol', icon: k[1] } : null;
    };
    const HEX = /^#[0-9a-fA-F]{6}$/;
    const validIcon = (x) => {
      if (!x || typeof x !== 'object') return null;
      if (x.kind === 'symbol' && ICON_CHOICES.includes(x.icon)) return { kind: 'symbol', icon: x.icon };
      if (x.kind === 'brand' && typeof x.text === 'string' && x.text.length <= 3 && HEX.test(x.bg) && HEX.test(x.fg)) {
        const logo = typeof x.logo === 'string' && /^(si:[a-z0-9]{1,40}|web:[a-z0-9.-]{1,80}\.[a-z]{2,})$/.test(x.logo) ? x.logo : null;
        return { kind: 'brand', text: x.text, bg: x.bg, fg: x.fg, ...(logo ? { logo } : {}) };
      }
      return null;
    };

    const SIMPLE_ICONS = 'https://cdn.jsdelivr.net/npm/simple-icons@16.36.0/icons/';
    const siteIcon = (domain) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
    const brokenLogos = new Set();

    function ItemIcon({ spec, tint = '#64748b', size = 28 }) {
      const box = { width: size, height: size, minWidth: size };
      const [failed, setFailed] = useState(false);
      const [alt, setAlt] = useState(false);
      const logo = spec && spec.kind === 'brand' && spec.logo && !failed && !brokenLogos.has(spec.logo) ? spec.logo : null;
      const markBroken = () => { brokenLogos.add(logo); setFailed(true); };
      if (logo && logo.startsWith('si:')) {
        const url = SIMPLE_ICONS + logo.slice(3) + '.svg';
        return (
          <span aria-hidden="true" className="inline-flex items-center justify-center rounded-[9px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]" style={{ ...box, background: spec.bg }}>
            <img src={url} alt="" onError={markBroken} className="hidden" />
            <span style={{ width: size * 0.62, height: size * 0.62, background: spec.fg,
              WebkitMask: `url(${url}) center / contain no-repeat`, mask: `url(${url}) center / contain no-repeat` }}></span>
          </span>
        );
      }
      if (logo && logo.startsWith('web:')) {
        return (
          <span aria-hidden="true" className="inline-flex items-center justify-center rounded-[9px] bg-white overflow-hidden shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]" style={box}>
            <img src={alt ? `https://icons.duckduckgo.com/ip3/${encodeURIComponent(logo.slice(4))}.ico` : siteIcon(logo.slice(4))} alt=""
              onError={() => alt ? markBroken() : setAlt(true)}
              onLoad={(e) => { if (e.currentTarget.naturalWidth <= 16) { if (alt) markBroken(); else setAlt(true); } }}
              style={{ width: size * 0.72, height: size * 0.72, objectFit: 'contain' }} />
          </span>
        );
      }
      if (spec && spec.kind === 'brand') {
        const len = spec.text.length;
        return (
          <span aria-hidden="true" className="inline-flex items-center justify-center rounded-[9px] font-bold tracking-tight leading-none shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] select-none"
            style={{ ...box, background: spec.bg, color: spec.fg, fontSize: len >= 3 ? size * 0.3 : len === 2 ? size * 0.38 : size * 0.48 }}>
            {spec.text || <i className="fa-brands fa-apple"></i>}
          </span>
        );
      }
      return (
        <span aria-hidden="true" className="inline-flex items-center justify-center rounded-[9px]" style={{ ...box, background: `${tint}22`, color: tint }}>
          <i className={`fa-solid ${(spec && spec.icon) || 'fa-tag'}`} style={{ fontSize: size * 0.44 }}></i>
        </span>
      );
    }

    // A question-mark link that unfolds an explanation instead of printing it everywhere.
    function Hint({ text, label }) {
      const [open, setOpen] = useState(false);
      return (
        <div className="text-[11px]">
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
            className="inline-flex items-center gap-1.5 text-tertiary hover:text-secondary">
            <i className="fa-regular fa-circle-question"></i><span>{label}</span>
          </button>
          {open && <p className="mt-1.5 leading-relaxed text-secondary">{text}</p>}
        </div>
      );
    }

    function Segmented({ options, value, onChange, size = 'md', full = false }) {
      return (
        <div className={`${full ? 'grid' : 'inline-grid'} gap-0.5 bg-subtle p-0.5 rounded-lg`} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
          {options.map(([id, label, sub]) => (
            <button key={id} type="button" onClick={() => onChange(id)} aria-pressed={value === id}
              className={`rounded-md font-medium transition ${size === 'sm' ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'} ${value === id ? 'bg-surface text-primary shadow-sm' : 'text-secondary hover:text-primary'}`}>
              <span className="block truncate">{label}</span>
              {sub != null && <span className="block text-[10px] font-normal opacity-70 font-mono">{sub}</span>}
            </button>
          ))}
        </div>
      );
    }

    function MoneyInput({ value, onChange, className = '', inputClass = 'text-primary font-medium', hideZero = true, ...rest }) {
      return (
        <div className={`money-input flex items-center bg-subtle border border-subtle rounded px-2 py-1 focus-within:border-strong ${className}`}>
          <input
            type="number" inputMode="decimal" placeholder="0"
            value={hideZero && value === 0 ? "" : value}
            onChange={(e) => onChange(e.target.value)}
            className={`w-full min-w-0 bg-transparent text-end font-mono text-xs outline-none ${inputClass}`}
            {...rest}
          />
          <span className="text-[10px] font-mono text-tertiary ms-1">€</span>
        </div>
      );
    }

    function ProgressBar({ value, total, className }) {
      const pct = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
      return (
        <div className="h-1.5 rounded-full bg-subtle overflow-hidden mt-2">
          <div className={`h-full rounded-full ${className}`} style={{ width: `${pct}%` }}></div>
        </div>
      );
    }

    function MainApp() {
      const { t, lang, changeLanguage } = useTranslation();
      const [data, setData] = useState(() => activeHousehold === HOUSEHOLD_IDS[0] ? normalizeState(null) : freshHousehold());
      const dataRef = useRef(data);

      const initialDate = useMemo(() => getCurrentInitialDate(), []);
      const [selectedYear, setSelectedYear] = useState(initialDate.year);
      const [selectedMonth, setSelectedMonth] = useState(initialDate.month);
      // Sections of the app: overview, month, activity, plan, more.
      const VIEWS = ['overview', 'month', 'book', 'activity', 'plan', 'health', 'more'];
      // View mode (default): page fields are locked; tap the pencil in the header to edit.
      const [view, setViewState] = useState(() => {
        // Icon shortcuts open the app with ?view=book (etc.).
        try { const q = new URLSearchParams(location.search).get('view'); if (VIEWS.includes(q)) { history.replaceState(null, '', location.pathname); return q; } } catch (e) {}
        const v = safeStorage.get('budget_view', 'overview'); return VIEWS.includes(v) ? v : 'overview';
      });
      const [anim, setAnim] = useState('view');
      const setView = (v) => { if (v !== view) haptic(6); setAnim('view'); setViewState(v); setMonthPicker(false); safeStorage.set('budget_view', v); try { window.scrollTo({ top: 0 }); } catch (e) {} };
      const [activityTab, setActivityTab] = useState('entries');
      const [monthPane, setMonthPane] = useState('expenses');
      const [monthPicker, setMonthPicker] = useState(false);
      const [heroDetails, setHeroDetails] = useState(false);
      const [showEmpty, setShowEmpty] = useState({});
      const readJson = (k) => { try { return JSON.parse(safeStorage.get(k, '{}')) || {}; } catch (e) { return {}; } };
      const [collapsed, setCollapsed] = useState(() => readJson('budget_collapsed'));
      const [dismissed, setDismissed] = useState(() => readJson('budget_dismissed'));
      useEffect(() => { safeStorage.set('budget_collapsed', JSON.stringify(collapsed)); }, [collapsed]);
      useEffect(() => { safeStorage.set('budget_dismissed', JSON.stringify(dismissed)); }, [dismissed]);
      const isAnnual = view === 'plan';
      const monthKey = `${selectedYear}_${selectedMonth}`;

      const [hideZeroes, setHideZeroes] = useState(() => safeStorage.get('budget_hide_zeroes', 'true') === 'true');
      const [isBurgerOpen, setIsBurgerOpen] = useState(false);
      const [theme, setTheme] = useState(() => safeStorage.get('budget_app_theme', 'dark'));
      // New features can be switched off one by one (menu → New features), kept on this device.
      const LABS_DEFAULT = { nowToday: true, reminders: true, importAmount: true, closeMonth: true, splitUp: true };
      const [labs, setLabsState] = useState(() => { try { return { ...LABS_DEFAULT, ...JSON.parse(safeStorage.get('budget_labs', '{}')) }; } catch (e) { return LABS_DEFAULT; } });
      const setLab = (k, v) => setLabsState(prev => { const next = { ...prev, [k]: v }; safeStorage.set('budget_labs', JSON.stringify(next)); return next; });
      const [motion, setMotionState] = useState(() => safeStorage.get('budget_motion', 'on') === 'off' ? 'off' : 'on');
      const setMotion = (v) => { setMotionState(v); safeStorage.set('budget_motion', v); if (v === 'off') document.documentElement.dataset.motion = 'off'; else delete document.documentElement.dataset.motion; };
      const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
      const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

      const [mobileTab, setMobileTab] = useState('expenses');

      const [openBrackets, setOpenBrackets] = useState({
        housing: true, subscriptions: true, living: true, professional: true, leisure: false, other: true, fixed_in: true, variable_in: true,
        g_fixed: true, g_flex: true
      });

      // Expense groups: which kinds to show, which row is expanded, receipt entry, group dialog.
      const [expFilter, setExpFilter] = useState(() => safeStorage.get('budget_exp_filter', 'all'));
      useEffect(() => { safeStorage.set('budget_exp_filter', expFilter); }, [expFilter]);
      const [openItem, setOpenItem] = useState(null);
      const [addingTo, setAddingTo] = useState(null);
      const [addAmount, setAddAmount] = useState("");
      const [receiptSheet, setReceiptSheet] = useState(false);
      const [receiptAmount, setReceiptAmount] = useState("");
      const [receiptHint, setReceiptHint] = useState(false);
      const [groupModal, setGroupModal] = useState(null);
      const [groupForm, setGroupForm] = useState({ name: "", kind: "fixed", color: "blue", moveTo: "" });
      const [toastMsg, setToastMsg] = useState(null);
      const toastTimerRef = useRef(null);

      const [balanceModal, setBalanceModal] = useState(false);
      const [txModal, setTxModal] = useState(false);
      const [logModal, setLogModal] = useState(false);
      const [askModal, setAskModal] = useState(false);
      const [askChat, setAskChat] = useState([]); // [{role, content, text}]
      const [askInput, setAskInput] = useState('');
      const [askBusy, setAskBusy] = useState(false);
      const [askError, setAskError] = useState('');
      const [logScope, setLogScope] = useState('month');
      const [balanceView, setBalanceView] = useState('end');
      const [importModal, setImportModal] = useState(null);
      const [dueExpanded, setDueExpanded] = useState(false);
      const [dueScope, setDueScope] = useState(() => {
        const v = safeStorage.get('budget_due_scope', 'this');
        return ['this', 'next', 'both'].includes(v) ? v : 'this';
      });
      useEffect(() => { safeStorage.set('budget_due_scope', dueScope); }, [dueScope]);
      const [backups, setBackups] = useState([]);
      useEffect(() => {
        if (isBurgerOpen) IDB.get(cacheKey('backups')).then(list => setBackups((list || []).slice().reverse()));
      }, [isBurgerOpen]);
      const [txWhoFilter, setTxWhoFilter] = useState('all');
      const [balanceInput, setBalanceInput] = useState("");

      const [openNoteRows, setOpenNoteRows] = useState({});
      const [highlightedCategory, setHighlightedCategory] = useState(null);

      const [breakdownModal, setBreakdownModal] = useState(false);
      const [activeEditCat, setActiveEditCat] = useState(null);
      const [editCatForm, setEditCatForm] = useState({ name: "", bracket: "", mode: "fixed", isOneTime: false, pDay: "", notes: [] });
      const [newBulletText, setNewBulletText] = useState("");

      const [recurringModal, setRecurringModal] = useState(null);
      const [editTab, setEditTab] = useState('details');
      // Item page (one item's month: its entries as cards) and the entry editor.
      const [itemSheet, setItemSheet] = useState(null);
      const [iconQuery, setIconQuery] = useState('');
      const [search, setSearch] = useState(null);
      const [entrySheet, setEntrySheet] = useState(null);
      const [recurringForm, setRecurringForm] = useState({ field: 'budget', amount: 0, from: '', until: '', every: 1, clearOutside: false });

      const [quickAddModal, setQuickAddModal] = useState(null);
      const [quickAddForm, setQuickAddForm] = useState({ name: "", bracket: "", budget: "", mode: "variable", isOneTime: false, from: "", until: "", every: 1 });

      const [smartDeleteModal, setSmartDeleteModal] = useState(null);

      const [loanModal, setLoanModal] = useState(null);
      const [loanEdit, setLoanEdit] = useState(null); // id of the loan being edited
      const [loanAddPos, setLoanAddPos] = useState('');
      const [loanForm, setLoanForm] = useState(null);

      const [iouPerson, setIouPerson] = useState("");
      const [iouAmount, setIouAmount] = useState("");
      const [iouType, setIouType] = useState("borrowed");

      // ---- Auth & sync ----
      const [user, setUser] = useState(null);
      const [syncStatus, setSyncStatus] = useState('local');
      const userRef = useRef(null);
      const saveTimerRef = useRef(null);
      const localEditedRef = useRef(false);
      const remoteLoadedRef = useRef(false);

      const chartRef = useRef(null);
      const chartInstanceRef = useRef(null);
      const fileInputRef = useRef(null);

      useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (e) => setSystemDark(e.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
      }, []);

      useEffect(() => {
        safeStorage.set('budget_app_theme', theme);
        const root = document.documentElement;
        root.setAttribute('data-theme', resolvedTheme);
        root.classList.toggle('dark', resolvedTheme === 'dark');
      }, [theme, resolvedTheme]);

      useEffect(() => {
        safeStorage.set('budget_hide_zeroes', hideZeroes ? 'true' : 'false');
      }, [hideZeroes]);

      const applyState = (next) => {
        dataRef.current = next;
        setData(next);
      };

      const [householdId, setHouseholdId] = useState(activeHousehold);
      useEffect(() => { try { document.title = data.name || t('title'); } catch (e) {} }, [data.name, lang]);
      const [households, setHouseholds] = useState([]);
      // Signed in, but the Firestore rules don't open any household for this account.
      const [noAccess, setNoAccess] = useState(false);
      // Ask again which households are open: after a "permission denied", and when the app comes back to the front.
      const [probeTick, setProbeTick] = useState(0);
      useEffect(() => {
        const again = () => { if (document.visibilityState === 'visible') setProbeTick(n => n + 1); };
        document.addEventListener('visibilitychange', again);
        return () => document.removeEventListener('visibilitychange', again);
      }, []);
      // Save what's pending in the current household, then load the other one (device cache first).
      // Starter kit for a family household: the usual incomes, bills and shops, added only where missing.
      // Amounts are only set where they are known (Sperrkonto, Kindergeld); the rest is filled in by the family.
      const STARTER = {
        incomes: [['Sperrkonto 1', 1092, 1, 12], ['Sperrkonto 2', 1092, 1, 12], ['Kindergeld', 500, null, 0]],
        expenses: [
          ['housing', 'Miete', 1], ['housing', 'Nebenkosten', null],
          ['bills', 'Strom ⚡', null], ['bills', 'Gas & Heizung', null], ['bills', 'Wasser', null], ['bills', 'Internet & Handy', null], ['bills', 'Rundfunkbeitrag', null], ['bills', 'Deutschlandticket', 1],
          ['insurance', 'Haftpflicht', null], ['insurance', 'Hausratversicherung', null],
          ['kids', 'Kita-Beitrag', null], ['kids', 'Kita Essensgeld', null], ['kids', 'Schulbedarf', null],
          ['groceries', 'Lebensmittel 🍞', null], ['groceries', 'Netto', null], ['groceries', 'Lidl', null], ['groceries', 'Aldi', null], ['groceries', 'Rewe', null], ['groceries', 'dm', null], ['groceries', 'Rossmann', null], ['groceries', 'Windeln & Baby', null],
          ['household', 'Hausrat 🛋️', null], ['household', 'Kleidung', null], ['household', 'Kinderkleidung', null], ['household', 'Spielzeug', null], ['household', 'Action', null], ['household', 'TEDi', null],
          ['leisure', 'Essen gehen 🍔', null], ['leisure', 'Ausflüge', null], ['leisure', 'Geschenke', null],
          ['oneoff', 'Sonstiges', null]
        ]
      };
      const applyStarterKit = () => mutateWithUndo(d => {
        const nowI = Math.max(0, nowIdx);
        if (!d.groups.find(g => g.id === 'kids')) d.groups.splice(Math.max(0, d.groups.findIndex(g => g.id === 'groceries')), 0, { id: 'kids', kind: 'fixed', color: 'pink', name: null });
        const ensureNode = (type, name, yr, m) => { const byCat = d.values[yr][type][name] || (d.values[yr][type][name] = {}); return byCat[m] || (byCat[m] = emptyNode()); };
        const has = (type, name) => d.categories[type].some(c => c.toLowerCase() === name.toLowerCase());
        const names = { 'Sperrkonto 1': `Sperrkonto ${d.members.me || '1'}`, 'Sperrkonto 2': `Sperrkonto ${d.members.partner || '2'}` };
        STARTER.incomes.forEach(([key, amount, payDay, months]) => {
          const name = names[key] || key;
          if (has('incomes', name)) return;
          d.categories.incomes.push(name);
          d.meta.incomes[name] = { bracket: key === 'Kindergeld' ? 'fixed_in' : 'fixed_in', mode: 'fixed', oneTime: false, payDay, forNext: false };
          TIMELINE.forEach(({ yr, m }, i) => {
            const n = ensureNode('incomes', name, yr, m);
            if (i >= nowI && (!months || i < nowI + months)) n.budget = amount;
          });
        });
        STARTER.expenses.forEach(([gid, name, payDay]) => {
          if (has('expenses', name)) return;
          const g = d.groups.find(x => x.id === gid) || d.groups.find(x => x.kind === 'oneoff') || d.groups[0];
          d.categories.expenses.push(name);
          d.meta.expenses[name] = { ...metaForGroup(d.groups, g.id, null, false), payDay };
          TIMELINE.forEach(({ yr, m }) => ensureNode('expenses', name, yr, m));
        });
        d.groups.forEach(g => { if (!d.targets[g.id]) d.targets[g.id] = {}; TIMELINE.forEach(({ yr, m }) => { (d.targets[g.id][yr] || (d.targets[g.id][yr] = {}))[m] ??= 0; }); });
      }, t('starterDone'));

      const switchHousehold = (id) => {
        if (id === activeHousehold) return;
        if (saveTimerRef.current) flushSave();
        undoRef.current = null;
        activeHousehold = id;
        safeStorage.set('budget_household', id);
        remoteLoadedRef.current = false;
        localEditedRef.current = false;
        applyState(id === HOUSEHOLD_IDS[0] ? normalizeState(null) : freshHousehold());
        IDB.get(cacheKey('app_state')).then(cached => {
          if (cached && activeHousehold === id && !remoteLoadedRef.current && !localEditedRef.current) applyState(normalizeState(cached));
        });
        setHouseholdId(id);
        setIsBurgerOpen(false);
      };

      const flushSave = () => {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const snapshot = dataRef.current;
        const u = userRef.current;
        if (db && u) {
          setSyncStatus('pending');
          // Start the Firestore write first so hasPendingWrites guards against echoes right away.
          stateDocRef()
            .set({ payload: snapshot, updatedAt: Date.now(), updatedBy: u.email || u.uid })
            .then(() => setSyncStatus('synced'))
            .catch(e => { console.error('Cloud save failed', e); setSyncStatus('error'); });
        } else {
          setSyncStatus('local');
        }
        IDB.set(cacheKey('app_state'), snapshot);
        saveDailyBackup(snapshot);
      };

      const scheduleSave = () => {
        clearTimeout(saveTimerRef.current);
        setSyncStatus(userRef.current ? 'pending' : 'local');
        saveTimerRef.current = setTimeout(flushSave, 700);
      };

      // Every edit goes through here: copy, change, show immediately, save debounced.
      const logBy = () => {
        const u = userRef.current;
        return (u?.displayName || '').trim().split(/\s+/)[0] || (u?.email || '').split('@')[0] || '';
      };
      // Append what changed between two states to next.log (typing one amount stays one entry).
      const writeLog = (prev, next, baseLog) => {
        let entries = diffForLog(prev, next);
        const now = new Date().toISOString();
        const by = logBy();
        const log = [...(baseLog || [])];
        if (entries.length > 150) entries = [{ k: 'bulk', n: entries.length }];
        entries.forEach(e => {
          const last = log[log.length - 1];
          const same = last && ['plan', 'done'].includes(e.k) && last.k === e.k && last.c === e.c && last.ty === e.ty && last.p === e.p
            && last.by === by && Date.parse(now) - Date.parse(last.t) < 120000;
          if (same) { last.n = e.n; last.t = now; if (last.o === last.n) log.pop(); }
          else log.push({ t: now, by, ...e });
        });
        next.log = log.slice(-LOG_MAX);
      };

      const mutate = (recipe) => {
        const prev = dataRef.current;
        const next = structuredClone(prev);
        recipe(next);
        writeLog(prev, next, next.log);
        localEditedRef.current = true;
        applyState(next);
        scheduleSave();
      };

      const replaceState = (next) => {
        const prev = dataRef.current;
        next = { ...next };
        // Undo and restores keep the history that exists so far.
        writeLog(prev, next, (prev.log || []).length >= (next.log || []).length ? prev.log : next.log);
        localEditedRef.current = true;
        applyState(next);
        scheduleSave();
      };

      // Local cache: shown first, but never allowed to overwrite newer remote data or fresh edits.
      useEffect(() => {
        IDB.get(cacheKey('app_state')).then(cached => {
          if (cached && !remoteLoadedRef.current && !localEditedRef.current) applyState(normalizeState(cached));
        });
      }, []);

      useEffect(() => {
        const onHide = () => { if (saveTimerRef.current) flushSave(); };
        const onVisibility = () => { if (document.visibilityState === 'hidden') onHide(); };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pagehide', onHide);
        return () => {
          document.removeEventListener('visibilitychange', onVisibility);
          window.removeEventListener('pagehide', onHide);
        };
      }, []);

      useEffect(() => {
        if (!auth) return;
        auth.getRedirectResult().catch(e => alert(t('signInError', { msg: e.message })));
        return auth.onAuthStateChanged(u => {
          userRef.current = u;
          setUser(u);
          setSyncStatus(u ? 'synced' : 'local');
        });
      }, []);

      useEffect(() => {
        if (!db || !user) return;
        remoteLoadedRef.current = false;
        return stateDocRef().onSnapshot(doc => {
          // Ignore echoes of our own writes and anything arriving while a local edit is waiting to save.
          if (doc.metadata.hasPendingWrites || saveTimerRef.current) return;
          if (!doc.exists) {
            // Seed the cloud from this device only once the server confirms the doc is really empty.
            if (!doc.metadata.fromCache) {
              if (activeHousehold !== HOUSEHOLD_IDS[0] && !localEditedRef.current) applyState(freshHousehold());
              flushSave();
            }
            return;
          }
          remoteLoadedRef.current = true;
          const next = normalizeState(doc.data().payload);
          applyState(next);
          IDB.set(cacheKey('app_state'), next);
        }, err => {
          console.error('Cloud sync error', err);
          setSyncStatus('error');
          if (err && err.code === 'permission-denied') setProbeTick(n => n + 1);
        });
      }, [user, householdId]);

      // Which households this account may open (decided by the Firestore rules).
      useEffect(() => {
        if (!db || !user) { setHouseholds([]); setNoAccess(false); return; }
        let alive = true;
        Promise.all(HOUSEHOLD_IDS.map(id => db.collection('monthly_logs').doc(id).get({ source: 'server' })
          .then(doc => ({ id, exists: doc.exists, name: doc.exists ? (doc.data().payload?.name || '') : '' }))
          .catch(() => null)))
          .then(list => {
            if (!alive) return;
            const open = list.filter(Boolean);
            setNoAccess(open.length === 0 && navigator.onLine !== false);
            // Existing households, plus one empty slot to start a new household in.
            const existing = open.filter(x => x.exists);
            const slot = open.find(x => !x.exists);
            setHouseholds(slot ? [...existing, slot] : existing);
            const usable = existing.length ? existing : open;
            if (usable.length && !usable.some(x => x.id === activeHousehold)) switchHousehold(usable[0].id);
          });
        return () => { alive = false; };
      }, [user, probeTick]);

      const handleSignIn = async () => {
        if (!auth) { alert(t('signInError', { msg: 'Firebase not loaded' })); return; }
        const provider = new firebase.auth.GoogleAuthProvider();
        try {
          await auth.signInWithPopup(provider);
        } catch (e) {
          if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
            auth.signInWithRedirect(provider);
          } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
            alert(t('signInError', { msg: e.message }));
          }
        }
      };

      const handleSignOut = () => {
        if (saveTimerRef.current) flushSave();
        auth?.signOut();
      };

      // ---- Helpers ----
      const fmtCents = (v) => new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'de-DE', {
        style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2
      }).format(v || 0);

      const fmt = (v) => new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'de-DE', {
        style: 'currency', currency: 'EUR', maximumFractionDigits: 0
      }).format(v || 0);

      const monthLabel = (yr, m) => yr === selectedYear ? formatMonth(m, lang) : `${formatMonth(m, lang)} ${yr}`;

      const getNode = (type, cat, yr, m) => data.values[yr]?.[type]?.[cat]?.[m] || emptyNode();

      const getMeta = (type, cat) => data.meta[type]?.[cat] || {
        bracket: type === 'incomes' ? 'fixed_in' : 'other', mode: 'variable', oneTime: false, payDay: null
      };

      const getTarget = (gid, yr, m) => data.targets?.[gid]?.[yr]?.[m] || 0;

      // Everything counts in the calendar month it happens (payday shifting switched off).
      const payday = null;
      const isReceiptItem = (cat) => {
        const meta = getMeta('expenses', cat);
        const g = data.groups.find(x => x.id === meta.bracket);
        return !!g && g.kind === 'variable' && !meta.oneTime;
      };
      // An item counts in the following month when marked so, or when it's paid on or after payday.
      const isForNextItem = (type, cat) => {
        const meta = getMeta(type, cat);
        if (type === 'expenses' && isReceiptItem(cat)) return false;
        return false;
      };
      // Receipts dated on or after payday belong to the next budget month.
      const lateReceipts = useMemo(() => {
        const map = {};
        if (!payday) return map;
        (data.tx || []).forEach(x => {
          if (x.type !== 'expenses' || !isReceiptItem(x.cat)) return;
          if (+x.date.slice(8, 10) < payday) return;
          const pos = dateToMonth(x.date);
          if (!pos) return;
          const key = `${pos.yr}|${pos.m}|${x.cat}`;
          map[key] = (map[key] || 0) + x.amount;
        });
        return map;
      }, [data, payday]);
      const lateFor = (cat, yr, m) => lateReceipts[`${yr}|${m}|${cat}`] || 0;
      // What a receipt item spent in budget month (yr, m): its calendar month minus the receipts
      // from payday on, plus those from payday on in the month before.
      const periodSpent = (cat, yr, m) => {
        const idx = timelineIndex(yr, m);
        const prev = idx > 0 ? TIMELINE[idx - 1] : null;
        return getNode('expenses', cat, yr, m).actual - lateFor(cat, yr, m) + (prev ? lateFor(cat, prev.yr, prev.m) : 0);
      };
      const groupName = (g) => g.name || t('groups.' + g.id);

      const getNotes = (type, cat) => data.notes[type]?.[cat]?.[monthKey] || [];

      const selectYear = (yr) => {
        setSelectedYear(yr);
        // Keep the selected month valid (2026 starts in May).
        if (selectedMonth !== "AnnualOverview" && !getMonthsForYear(yr).includes(selectedMonth)) {
          setSelectedMonth(getMonthsForYear(yr)[0]);
        }
      };

      // The one tunnel: a month's real amount only changes through entries. Raising it adds an entry,
      // lowering it trims the newest entries. node.actual always equals the sum of the entries.
      const setActualTx = (d, type, cat, yr, m, target, source = 'manual') => {
        const byCat = d.values[yr][type][cat] || (d.values[yr][type][cat] = {});
        const node = byCat[m] || (byCat[m] = emptyNode());
        target = Math.round(Math.max(0, parseFloat(target) || 0) * 100) / 100;
        let diff = Math.round((target - node.actual) * 100) / 100;
        const prefix = `${yr}-${pad2(ALL_MONTHS.indexOf(m) + 1)}-`;
        if (diff > 0.005) {
          const pd = (d.meta[type][cat] || {}).payDay;
          const days = getDaysInMonth(yr, m);
          const status = monthStatus(yr, m);
          const today = new Date().getDate();
          const day = Number.isInteger(pd) ? Math.min(Math.max(pd, 1), days, status === 'current' ? today : days) : status === 'current' ? today : 1;
          d.tx.push({ id: newTxId(), date: prefix + pad2(day), type, cat, amount: diff, who: null, note: '', source, account: null,
            undated: !Number.isInteger(pd) && status !== 'current' });
        } else if (diff < -0.005) {
          const mine = d.tx.filter(x => x.type === type && x.cat === cat && x.date.startsWith(prefix));
          while (diff < -0.005 && mine.length) {
            const last = mine.pop();
            if (last.amount <= -diff + 0.005) { diff = Math.round((diff + last.amount) * 100) / 100; d.tx = d.tx.filter(x => x.id !== last.id); }
            else { last.amount = Math.round((last.amount + diff) * 100) / 100; diff = 0; }
          }
        }
        node.actual = target;
      };

      const updateNode = (type, cat, yr, m, field, val) => {
        mutate(d => {
          const byCat = d.values[yr][type][cat] || (d.values[yr][type][cat] = {});
          const node = byCat[m] || (byCat[m] = emptyNode());
          if (field === 'actual') { setActualTx(d, type, cat, yr, m, val, 'tick'); return; }
          if (field === 'asOfDate') {
            const n = parseInt(val);
            node.asOfDate = isNaN(n) ? null : Math.min(getDaysInMonth(yr, m), Math.max(1, n));
          } else {
            const n = parseFloat(val);
            node[field] = isNaN(n) ? 0 : n;
          }
        });
      };

      // ---- Derived numbers ----
      const forwardTimeline = useMemo(() => {
        const groupById = Object.fromEntries(data.groups.map(g => [g.id, g]));
        let runningBalance = data.startingCapital || 0;
        const anchorIdx = Math.max(0, TIMELINE.findIndex(x => timelineKey(x.yr, x.m) === data.startingMonth));
        const rows = TIMELINE.map(({ yr, m }, idx) => {
          let budgetIn = 0, actualIn = 0, projectedIn = 0;
          // A finished month counts only what really came in and went out; open plans there never happened.
          const past = monthStatus(yr, m) === 'past';
          const inc = (node) => past ? node.actual : expectedIncome(node);
          const known = (node) => past ? node.actual : knownAmount(node);
          let budgetEx = 0, actualEx = 0, projectedEx = 0;
          const fixed = { plan: 0, paid: 0, expected: 0, items: 0, paidItems: 0 };
          const flex = { plan: 0, spent: 0, expected: 0 };

          // "Live on last month's income": income marked for next month is booked where it arrives
          // but counts in the following month, the one it is actually spent in.
          const prevPos = idx > 0 ? TIMELINE[idx - 1] : null;
          let shiftedIn = 0, shiftedActual = 0, arrivingForNext = 0, arrivedForNextActual = 0;
          data.categories.incomes.forEach(cat => {
            if (isForNextItem('incomes', cat)) {
              const here = getNode('incomes', cat, yr, m);
              arrivingForNext += expectedIncome(here);
              arrivedForNextActual += here.actual;
              if (!prevPos) return;
              const node = getNode('incomes', cat, prevPos.yr, prevPos.m);
              budgetIn += node.budget;
              actualIn += node.actual;
              projectedIn += inc(node);
              shiftedIn += inc(node);
              shiftedActual += node.actual;
              return;
            }
            const node = getNode('incomes', cat, yr, m);
            budgetIn += node.budget;
            actualIn += node.actual;
            projectedIn += inc(node);
          });

          const spentByGroup = {};
          let shiftedEx = 0, shiftedExActual = 0, leavingForNext = 0, leftForNextActual = 0;
          // Receipts from payday on: shown inside their group, but needed for the real-balance math.
          let lateVarPrev = 0, lateVarHere = 0;
          data.categories.expenses.forEach(cat => {
            const meta = getMeta('expenses', cat);
            const g = groupById[meta.bracket];
            let node = getNode('expenses', cat, yr, m);
            if (isForNextItem('expenses', cat)) {
              // Paid at the end of this month from the new salary → counts next month.
              leavingForNext += known(node);
              leftForNextActual += node.actual;
              if (!prevPos) return;
              node = getNode('expenses', cat, prevPos.yr, prevPos.m);
              const expected = known(node);
              actualEx += node.actual;
              budgetEx += node.budget;
              projectedEx += expected;
              shiftedEx += expected;
              shiftedExActual += node.actual;
              return;
            }
            if (g && g.kind === 'variable' && !meta.oneTime) {
              // Receipts after payday move to the next budget month.
              const lateHere = lateFor(cat, yr, m);
              const latePrev = prevPos ? lateFor(cat, prevPos.yr, prevPos.m) : 0;
              const spent = node.actual - lateHere + latePrev;
              actualEx += spent;
              spentByGroup[g.id] = (spentByGroup[g.id] || 0) + spent;
              lateVarPrev += latePrev;
              lateVarHere += lateHere;
              return;
            }
            actualEx += node.actual;
            const expected = known(node);
            budgetEx += node.budget;
            projectedEx += expected;
            if (g && g.kind === 'fixed' && !meta.oneTime) {
              fixed.plan += node.budget;
              fixed.paid += node.actual;
              fixed.expected += expected;
              if (node.budget > 0 || node.actual > 0) {
                fixed.items += 1;
                if (node.actual > 0) fixed.paidItems += 1;
              }
            } else {
              flex.plan += node.budget;
              flex.spent += node.actual;
              flex.expected += expected;
            }
          });
          data.groups.filter(g => g.kind === 'variable').forEach(g => {
            const spent = spentByGroup[g.id] || 0;
            const target = getTarget(g.id, yr, m);
            const expected = variableExpected(spent, target, yr, m);
            budgetEx += target;
            projectedEx += expected;
            flex.plan += target;
            flex.spent += spent;
            flex.expected += expected;
          });

          const actualNet = actualIn - actualEx;
          const projectedNet = projectedIn - projectedEx;
          const counted = idx >= anchorIdx;
          const startBal = counted ? runningBalance : null;
          if (counted) runningBalance += projectedNet;

          return {
            year: yr, month: m, key: `${m} ${yr}`, daysInMonth: getDaysInMonth(yr, m),
            budgetIn, actualIn, projectedIn, budgetEx, actualEx, projectedEx, fixed, flex,
            shiftedIn, shiftedActual, arrivingForNext, arrivedForNextActual,
            shiftedEx, shiftedExActual, leavingForNext, leftForNextActual, lateVarPrev, lateVarHere,
            actualNet, projectedNet, isAnchor: idx === anchorIdx,
            startBal, endProjectedBalance: counted ? runningBalance : null
          };
        });
        // Months before the anchor: work back from the anchored balance using what actually
        // came in and went out, so earlier months still show their balances.
        for (let i = anchorIdx - 1; i >= 0; i--) {
          const end = rows[i + 1].startBal;
          rows[i].endProjectedBalance = end;
          rows[i].startBal = end - rows[i].projectedNet;
          rows[i].backCalculated = true;
        }
        return rows;
      }, [data, lateReceipts]);

      const yearRows = useMemo(() => forwardTimeline.filter(r => r.year === selectedYear), [forwardTimeline, selectedYear]);

      const currentMetrics = useMemo(() => {
        if (!isAnnual) {
          return forwardTimeline.find(r => r.year === selectedYear && r.month === selectedMonth) || forwardTimeline[0];
        }
        const sum = (k) => yearRows.reduce((s, r) => s + r[k], 0);
        return {
          actualIn: sum('actualIn'), actualEx: sum('actualEx'), actualNet: sum('actualNet'),
          projectedIn: sum('projectedIn'), projectedEx: sum('projectedEx'), projectedNet: sum('projectedNet'),
          endProjectedBalance: yearRows[yearRows.length - 1]?.endProjectedBalance ?? null
        };
      }, [forwardTimeline, yearRows, selectedYear, selectedMonth, isAnnual]);

      const groupView = useMemo(() => {
        if (isAnnual) return [];
        return data.groups.map(g => {
          const items = data.categories.expenses
            .filter(cat => getMeta('expenses', cat).bracket === g.id)
            .map(cat => ({ cat, node: getNode('expenses', cat, selectedYear, selectedMonth), once: !!getMeta('expenses', cat).oneTime }));
          if (g.kind === 'variable') {
            const spent = items.filter(i => !i.once).reduce((s, i) => s + periodSpent(i.cat, selectedYear, selectedMonth), 0);
            const onceTotal = items.filter(i => i.once).reduce((s, i) => s + knownAmount(i.node), 0);
            const target = getTarget(g.id, selectedYear, selectedMonth);
            return { g, items, spent, target, expected: variableExpected(spent, target, selectedYear, selectedMonth) + onceTotal };
          }
          const total = items.reduce((s, i) => s + knownAmount(i.node), 0);
          const paid = items.reduce((s, i) => s + i.node.actual, 0);
          const active = items.filter(i => i.node.budget > 0 || i.node.actual > 0);
          return {
            g, items, total, paid, open: Math.max(0, total - paid), expected: total,
            n: active.length, nPaid: active.filter(i => i.node.actual > 0).length
          };
        });
      }, [data, selectedYear, selectedMonth, isAnnual, lateReceipts]);

      const fmtBalance = (v) => v == null ? '–' : fmt(v);

      // Year report: spending per group, biggest items, and who paid (from entries).
      const yearReport = useMemo(() => {
        if (!isAnnual) return null;
        const months = getMonthsForYear(selectedYear);
        const spentIn = (cat) => months.reduce((sum, m) => sum + getNode('expenses', cat, selectedYear, m).actual, 0);
        const activeMonths = months.filter(m => data.categories.expenses.some(c => getNode('expenses', c, selectedYear, m).actual > 0)).length || 1;
        const groups = data.groups.map(g => {
          const total = data.categories.expenses.filter(c => getMeta('expenses', c).bracket === g.id).reduce((sum, c) => sum + spentIn(c), 0);
          return { g, total, avg: total / activeMonths };
        }).filter(x => x.total > 0).sort((a, b) => b.total - a.total);
        const items = data.categories.expenses.map(c => ({ cat: c, total: spentIn(c) })).filter(x => x.total > 0).sort((a, b) => b.total - a.total).slice(0, 8);
        const yearTx = (data.tx || []).filter(x => x.type === 'expenses' && x.date.startsWith(String(selectedYear)));
        const byWho = WHO.map(w => ({ w, total: yearTx.filter(x => x.who === w).reduce((sum, x) => sum + x.amount, 0) }));
        return { groups, items, byWho, max: Math.max(1, ...groups.map(x => x.total)), activeMonths };
      }, [data, selectedYear, isAnnual]);

      // ---- Planning: what's due, where the balance is heading, what to set aside ----
      const nowIdx = (() => { const d = new Date(); return timelineIndex(d.getFullYear(), ALL_MONTHS[d.getMonth()]); })();
      const isKnownItem = (cat) => {
        const meta = getMeta('expenses', cat);
        const g = data.groups.find(x => x.id === meta.bracket);
        return meta.oneTime || !g || g.kind !== 'variable';
      };

      // Planned bills not paid yet, this month and next, sorted by due day.
      const dueSoon = useMemo(() => {
        if (nowIdx === -1) return [];
        const today = new Date().getDate();
        const out = [];
        [0, 1].forEach(off => {
          const p = TIMELINE[nowIdx + off];
          if (!p) return;
          data.categories.expenses.forEach(cat => {
            if (!isKnownItem(cat)) return;
            const node = getNode('expenses', cat, p.yr, p.m);
            if (!(node.budget > 0) || node.actual > 0) return;
            const payDay = getMeta('expenses', cat).payDay;
            const day = payDay ? Math.min(payDay, getDaysInMonth(p.yr, p.m)) : null;
            out.push({ cat, yr: p.yr, m: p.m, off, day, overdue: off === 0 && day !== null && day < today, amount: node.budget });
          });
        });
        return out.sort((a, b) => (b.overdue - a.overdue) || (a.off - b.off) || ((a.day || 99) - (b.day || 99)));
      }, [data, nowIdx]);

      // Reminders: bills due today, tomorrow or overdue, and planned income that should have arrived.
      const reminders = useMemo(() => {
        if (!labs.reminders || nowIdx === -1) return [];
        const p = TIMELINE[nowIdx], today = new Date().getDate();
        const out = dueSoon.filter(x => x.off === 0 && (x.overdue || x.day === today || x.day === today + 1))
          .map(x => ({ kind: 'bill', cat: x.cat, amount: x.amount, day: x.day, when: x.overdue ? 'overdue' : x.day === today ? 'today' : 'tomorrow' }));
        data.categories.incomes.forEach(cat => {
          const n = getNode('incomes', cat, p.yr, p.m), pd = getMeta('incomes', cat).payDay;
          if (n.budget > 0 && n.actual < 0.005 && Number.isInteger(pd) && pd < today) out.push({ kind: 'income', cat, amount: n.budget, day: pd, when: 'late' });
        });
        return out;
      }, [dueSoon, data, nowIdx, labs.reminders]);
      const [notifPerm, setNotifPerm] = useState(() => { try { return window.Notification ? Notification.permission : 'unsupported'; } catch (e) { return 'unsupported'; } });
      const askNotif = async () => { try { const r = await Notification.requestPermission(); setNotifPerm(r); } catch (e) {} };
      // One phone notification a day, when the app is opened or comes back to the front.
      useEffect(() => {
        if (!labs.reminders || notifPerm !== 'granted' || !reminders.length) return;
        const fire = async () => {
          if (document.visibilityState !== 'visible') return;
          const key = 'budget_notified_' + householdId, today = todayISO();
          if (safeStorage.get(key, '') === today) return;
          safeStorage.set(key, today);
          const body = reminders.slice(0, 4).map(r => `${r.cat} · ${fmtCents(r.amount)} · ${t('rem_' + r.when)}`).join('\n');
          try {
            const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
            if (reg && reg.showNotification) reg.showNotification(t('remTitle', { n: reminders.length }), { body, icon: 'icon-192.png', tag: 'due-' + today });
            else new Notification(t('remTitle', { n: reminders.length }), { body, icon: 'icon-192.png' });
          } catch (e) {}
        };
        fire();
        document.addEventListener('visibilitychange', fire);
        return () => document.removeEventListener('visibilitychange', fire);
      }, [reminders, notifPerm, labs.reminders, householdId]);

      // Regular incomes whose payments stop within the next 12 months (e.g. a blocked account running out).
      const incomeEndings = useMemo(() => {
        if (nowIdx === -1) return { rows: [], groups: [] };
        const rows = [];
        data.categories.incomes.forEach(cat => {
          const meta = getMeta('incomes', cat);
          if (meta.oneTime) return;
          const amounts = TIMELINE.map(p => expectedIncome(getNode('incomes', cat, p.yr, p.m)));
          let last = -1;
          for (let i = TIMELINE.length - 1; i >= nowIdx; i--) if (amounts[i] > 0) { last = i; break; }
          if (last === -1 || last === TIMELINE.length - 1) return; // nothing ahead, or still paying at the end
          if (amounts.slice(Math.max(0, last - 11), last + 1).filter(v => v > 0).length < 3) return; // not a regular income
          const countsIdx = isForNextItem('incomes', cat) ? last + 1 : last;
          const fromIdx = countsIdx + 1;
          if (fromIdx >= TIMELINE.length || fromIdx > nowIdx + 12) return;
          rows.push({ cat, last: TIMELINE[last], from: TIMELINE[fromIdx], fromIdx, amount: amounts[last], payDay: meta.payDay });
        });
        rows.sort((a, b) => a.fromIdx - b.fromIdx);
        const groups = [];
        rows.forEach(r => {
          const g = groups.find(x => x.fromIdx === r.fromIdx);
          if (g) g.total += r.amount; else groups.push({ fromIdx: r.fromIdx, from: r.from, total: r.amount });
        });
        return { rows, groups };
      }, [data, nowIdx]);

      const forecast = useMemo(() => {
        if (nowIdx === -1) return [];
        return forwardTimeline.slice(nowIdx, nowIdx + 12).filter(r => r.endProjectedBalance != null);
      }, [forwardTimeline, nowIdx]);
      // Outlook can also show the months behind you (real month-end balances).
      const [forecastRange, setForecastRangeState] = useState(() => safeStorage.get('budget_forecast_range', 'next'));
      const setForecastRange = (v) => { setForecastRangeState(v); safeStorage.set('budget_forecast_range', v); };
      const forecastShown = useMemo(() => {
        if (forecastRange !== 'all' || nowIdx === -1) return forecast;
        return forwardTimeline.slice(0, nowIdx + 12).filter(r => r.endProjectedBalance != null);
      }, [forecast, forecastRange, forwardTimeline, nowIdx]);

      // Irregular costs (quarterly, yearly) and future one-time payments, as a monthly amount to put aside.
      const setAsides = useMemo(() => {
        if (nowIdx === -1) return { rows: [], total: 0 };
        const span = TIMELINE.slice(nowIdx, nowIdx + 12);
        const rows = [];
        data.categories.expenses.forEach(cat => {
          if (!isKnownItem(cat)) return;
          const meta = getMeta('expenses', cat);
          const plans = span.map(p => getNode('expenses', cat, p.yr, p.m).budget);
          const months = plans.map((v, i) => v > 0 ? i : -1).filter(i => i !== -1);
          if (!months.length) return;
          if (meta.oneTime) {
            const i = months[0];
            const node = getNode('expenses', cat, span[i].yr, span[i].m);
            if (i === 0 || node.actual > 0) return; // due now or already paid
            rows.push({ cat, kind: 'once', amount: plans[i], next: span[i], perMonth: plans[i] / (i + 1) });
            return;
          }
          const consecutive = months.every((v, k) => k === 0 || v === months[k - 1] + 1);
          if (consecutive && months.length > 1) return; // regular monthly bill
          if (months.length === span.length) return;
          const total = plans.reduce((sum, v) => sum + v, 0);
          rows.push({ cat, kind: 'irregular', count: months.length, amount: Math.max(...plans), next: span[months[0]], perMonth: total / span.length });
        });
        rows.sort((a, b) => b.perMonth - a.perMonth);
        return { rows, total: rows.reduce((sum, r) => sum + r.perMonth, 0) };
      }, [data, nowIdx]);

      // Savings goals live outside the month budget: saved amounts are tracked here only.
      const [goalModal, setGoalModal] = useState(null);
      const [depositFor, setDepositFor] = useState(null);
      const [depositAmount, setDepositAmount] = useState('');
      const monthsUntil = (key) => {
        if (!key || nowIdx === -1) return null;
        const idx = keyIndex(key);
        return idx === -1 ? null : Math.max(1, idx - nowIdx + 1);
      };
      const saveGoal = () => {
        const g = goalModal;
        const target = parseAmount(g.target);
        if (!g.name.trim() || target === null) return;
        mutate(d => {
          const existing = d.goals.find(x => x.id === g.id);
          const fields = { name: g.name.trim(), target, saved: parseAmount(g.saved) || 0, deadline: g.deadline || null };
          if (existing) Object.assign(existing, fields);
          else d.goals.push({ id: 'goal' + Date.now().toString(36), ...fields });
        });
        setGoalModal(null);
      };
      const depositGoal = (id) => {
        const amount = parseAmount(depositAmount);
        if (amount === null) return;
        const goal = data.goals.find(x => x.id === id);
        mutateWithUndo(d => {
          const g = d.goals.find(x => x.id === id);
          if (g) g.saved = round2(g.saved + amount);
        }, t('goalDeposited', { amount: fmtCents(amount), name: goal?.name || '' }));
        setDepositFor(null);
        setDepositAmount('');
      };

      const prevMonthOf = (yr, m) => {
        const idx = timelineIndex(yr, m);
        return idx > 0 ? TIMELINE[idx - 1] : null;
      };

      const monthlyReceipt = useMemo(() => {
        const build = (type) => data.categories[type]
          .map(cat => ({ cat, ...getNode(type, cat, selectedYear, selectedMonth) }))
          .filter(i => i.actual > 0 || i.budget > 0)
          .sort((a, b) => b.actual - a.actual);
        return { incomeItems: build('incomes'), expenseItems: build('expenses') };
      }, [data, selectedYear, selectedMonth]);

      // ---- Category actions ----
      const checkDuplicate = (type, name, excludeCat = null) => {
        const test = name.trim().toLowerCase();
        if (!test) return null;
        const hit = data.categories[type].find(c => c.toLowerCase() === test && c !== excludeCat);
        if (!hit) return null;
        const where = type === 'expenses'
          ? groupName(data.groups.find(g => g.id === getMeta(type, hit).bracket) || data.groups[0])
          : t('brackets.' + getMeta(type, hit).bracket);
        return { name: hit, bracket: where };
      };

      const flashCategory = (name) => {
        setHighlightedCategory(name);
        setTimeout(() => setHighlightedCategory(null), 2500);
      };

      const LAST_KEY = timelineKey(TIMELINE[TIMELINE.length - 1].yr, TIMELINE[TIMELINE.length - 1].m);
      const keyIndex = (key) => TIMELINE.findIndex(x => timelineKey(x.yr, x.m) === key);
      const keyLabel = (key) => {
        const [yr, m] = key.split('|');
        return `${formatMonth(m, lang)} ${yr}`;
      };
      // Inclusive [from, until] as timeline indexes, tolerating a reversed pick.
      const rangeIndexes = (fromKey, untilKey) => {
        const a = keyIndex(fromKey), b = keyIndex(untilKey);
        return a <= b ? [a, b] : [b, a];
      };

      const handleCreateCategory = (type, name, bracketId, mode, initialBudget = 0, isOneTime = false, fromKey, untilKey = LAST_KEY, every = 1) => {
        const val = name.trim();
        if (!val) return;
        const dup = checkDuplicate(type, val);
        if (dup) {
          alert(t('duplicateAlert', { name: dup.name, bracket: dup.bracket }));
          return;
        }
        const isExpense = type === 'expenses';
        const group = isExpense ? (data.groups.find(g => g.id === bracketId) || data.groups[0]) : null;
        const oneTime = isExpense ? (group.kind === 'oneoff' || !!isOneTime) : !!isOneTime;
        // Recurring variable items only collect receipts; their group holds the target.
        const amount = isExpense && group.kind === 'variable' && !oneTime ? 0 : (parseFloat(initialBudget) || 0);
        const [fromIdx, untilIdx] = oneTime
          ? [keyIndex(fromKey), keyIndex(fromKey)]
          : rangeIndexes(fromKey, untilKey);

        mutate(d => {
          d.categories[type].push(val);
          d.meta[type][val] = isExpense
            ? metaForGroup(d.groups, group.id, null, oneTime && group.kind !== 'oneoff')
            : { bracket: bracketId, mode: mode || 'variable', oneTime, payDay: null };
          TIMELINE.forEach(({ yr, m }, idx) => {
            if (!d.values[yr][type][val]) d.values[yr][type][val] = {};
            // Plan the amount only inside the chosen period, every N months from its start.
            const planned = idx >= fromIdx && idx <= untilIdx && (idx - fromIdx) % every === 0;
            d.values[yr][type][val][m] = { budget: planned ? amount : 0, actual: 0, asOfDate: null };
          });
        });

        setOpenBrackets(prev => ({ ...prev, [isExpense ? group.id : bracketId]: true }));
        flashCategory(val);
        setQuickAddModal(null);
      };

      const handleOpenQuickAdd = (type, defaultBracket = null, defaultMode = null) => {
        const bracketsList = type === 'incomes' ? data.brackets.incomes : data.groups;
        const bracket = defaultBracket || bracketsList[0]?.id || 'other';
        setQuickAddModal({ type });
        setQuickAddForm({
          name: "",
          bracket,
          budget: "",
          mode: defaultMode || (type === 'incomes' ? 'fixed' : 'variable'),
          // Opened from a one-time group, the new item is one-time too.
          isOneTime: type === 'expenses' && data.groups.find(g => g.id === bracket)?.kind === 'oneoff',
          from: timelineKey(selectedYear, selectedMonth),
          until: LAST_KEY,
          every: 1
        });
      };

      const handleOpenRecurring = (type, cat) => {
        const node = getNode(type, cat, selectedYear, selectedMonth);
        setRecurringModal({ type, cat });
        // Setting amounts for a period is about the plan; prefill with what this month has.
        setRecurringForm({
          field: 'budget',
          amount: node.budget || node.actual,
          from: timelineKey(selectedYear, selectedMonth),
          until: LAST_KEY,
          every: 1,
          clearOutside: false
        });
      };

      // "Different every month": the amount shown (and saved) for a month in the period.
      const perMonthValue = (form, type, cat, yr, m) => {
        const k = timelineKey(yr, m);
        if (form.perMonth && form.perMonth[k] != null && form.perMonth[k] !== '') return parseFloat(String(form.perMonth[k]).replace(',', '.')) || 0;
        const b = data.values[yr]?.[type]?.[cat]?.[m]?.budget || 0;
        return b > 0 ? b : (parseFloat(form.amount) || 0);
      };
      const handleExecuteRecurring = () => {
        const target = recurringModal || activeEditCat;
        if (!target) return;
        const { type, cat } = target;
        const { field, amount, from, until, clearOutside } = recurringForm;
        const every = parseInt(recurringForm.every) || 1;
        const [fromIdx, untilIdx] = rangeIndexes(from, until);
        if (fromIdx === -1) return;
        const value = parseFloat(amount) || 0;
        const firstValue = recurringForm.firstOn ? (parseFloat(recurringForm.firstAmount) || 0) : null;

        mutate(d => {
          TIMELINE.forEach(({ yr, m }, idx) => {
            const inside = idx >= fromIdx && idx <= untilIdx;
            const paymentMonth = inside && (idx - fromIdx) % every === 0;
            // Plans: the amount in payment months, 0 in the months between them (and outside,
            // when asked). Actuals are history, so only payment months are written.
            if (field === 'actual' && !paymentMonth) return;
            if (!inside && !clearOutside) return;
            const byCat = d.values[yr][type][cat] || (d.values[yr][type][cat] = {});
            const node = byCat[m] || (byCat[m] = emptyNode());
            if (field === 'actual') setActualTx(d, type, cat, yr, m, paymentMonth ? value : 0, 'tick');
            else node[field] = !paymentMonth ? 0 : recurringForm.perMonthOn ? perMonthValue(recurringForm, type, cat, yr, m)
              : (idx === fromIdx && firstValue !== null ? firstValue : value);
          });
        });
        setRecurringModal(null);
      };

      // The plan as it really is across all months: first planned month, the usual amount and rhythm,
      // a different first payment, and the last planned month (or "open end").
      const detectSchedule = (type, cat) => {
        const pts = [];
        TIMELINE.forEach(({ yr, m }, idx) => { const b = data.values[yr]?.[type]?.[cat]?.[m]?.budget || 0; if (b > 0) pts.push({ idx, b }); });
        if (!pts.length) return null;
        const mode = (arr) => { const c = new Map(); arr.forEach(v => c.set(v, (c.get(v) || 0) + 1)); return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]; };
        const gaps = pts.slice(1).map((p, i) => p.idx - pts[i].idx);
        const every = gaps.length ? mode(gaps) : 1;
        const rest = pts.length > 1 ? pts.slice(1).map(p => p.b) : pts.map(p => p.b);
        const regular = mode(rest);
        const first = pts[0].b;
        const last = pts[pts.length - 1].idx;
        const openEnd = last + every > TIMELINE.length - 1;
        const P = (i) => TIMELINE[i];
        return { fromIdx: pts[0].idx, lastIdx: last, every, regular, first, firstDiffers: Math.abs(first - regular) > 0.004 && pts.length > 1,
          from: timelineKey(P(pts[0].idx).yr, P(pts[0].idx).m), until: openEnd ? LAST_KEY : timelineKey(P(last).yr, P(last).m), openEnd,
          odd: pts.slice(1).filter(p => Math.abs(p.b - regular) > 0.004).length };
      };

      const handleOpenEditCategory = (type, cat, tab = 'details') => {
        const meta = getMeta(type, cat);
        setActiveEditCat({ type, cat });
        setEditCatForm({
          name: cat,
          bracket: meta.bracket,
          mode: meta.mode,
          isOneTime: !!meta.oneTime,
          forNext: !!meta.forNext,
          pDay: meta.payDay || "",
          wasOneTime: !!meta.oneTime,
          notes: [...getNotes(type, cat)]
        });
        setNewBulletText("");
        setIconQuery('');
        // The same dialog also sets amounts for a period (tab "Amounts & period").
        const node = getNode(type, cat, selectedYear, selectedMonth);
        const sch = detectSchedule(type, cat);
        setRecurringForm(sch
          ? { field: 'budget', amount: sch.regular, firstAmount: sch.firstDiffers ? sch.first : '', firstOn: sch.firstDiffers && sch.odd === 0, perMonthOn: sch.odd > 0, perMonth: {}, from: sch.from, until: sch.until, every: sch.every, clearOutside: false, sch }
          : { field: 'budget', amount: node.budget || node.actual, firstAmount: '', firstOn: false, from: timelineKey(selectedYear, selectedMonth), until: LAST_KEY, every: 1, clearOutside: false, sch: null });
        setEditTab(tab);
      };

      // Shops and other day-to-day items have no plan, due day or period: only name, icon, group and notes.
      const editIsShop = !!activeEditCat && activeEditCat.type === 'expenses' && data.groups.find(g => g.id === editCatForm.bracket)?.kind === 'variable' && !editCatForm.isOneTime;

      const handleSaveCategoryChanges = () => {
        if (!activeEditCat) return;
        const { type, cat: oldName } = activeEditCat;
        const newName = editCatForm.name.trim();
        if (!newName) return;

        if (newName !== oldName) {
          const dup = checkDuplicate(type, newName, oldName);
          if (dup) {
            alert(t('duplicateAlert', { name: dup.name, bracket: dup.bracket }));
            return;
          }
        }

        // Include a note still sitting in the input box.
        const notes = newBulletText.trim() ? [...editCatForm.notes, newBulletText.trim()] : editCatForm.notes;

        mutate(d => {
          if (newName !== oldName) {
            d.categories[type] = d.categories[type].map(c => c === oldName ? newName : c);
            YEARS.forEach(yr => {
              const byType = d.values[yr][type];
              if (byType[oldName]) {
                byType[newName] = byType[oldName];
                delete byType[oldName];
              }
            });
            d.tx.forEach(x => { if (x.type === type && x.cat === oldName) x.cat = newName; });
            if (d.icons[oldName]) { d.icons[newName] = d.icons[oldName]; delete d.icons[oldName]; }
            // Notes are stored per category, so all months move with the rename.
            if (d.notes[type][oldName]) {
              d.notes[type][newName] = d.notes[type][oldName];
              delete d.notes[type][oldName];
            }
            delete d.meta[type][oldName];
          }

          const day = parseInt(editCatForm.pDay);
          const payDay = day >= 1 && day <= 31 ? day : null;
          const targetGroup = type === 'expenses' ? d.groups.find(g => g.id === editCatForm.bracket) : null;
          d.meta[type][newName] = type === 'expenses'
            ? metaForGroup(d.groups, editCatForm.bracket, payDay, editCatForm.isOneTime && targetGroup?.kind !== 'oneoff', !!editCatForm.forNext)
            : { bracket: editCatForm.bracket, mode: editCatForm.mode, oneTime: editCatForm.isOneTime, payDay, forNext: !!editCatForm.forNext };

          // Turning a recurring item into a one-time one keeps only this month's plan.
          if (d.meta[type][newName].oneTime && !editCatForm.wasOneTime) {
            TIMELINE.forEach(({ yr, m }) => {
              if (yr === selectedYear && m === selectedMonth) return;
              const node = d.values[yr][type][newName]?.[m];
              if (node) node.budget = 0;
            });
          }

          const byMonth = d.notes[type][newName] || (d.notes[type][newName] = {});
          if (notes.length) byMonth[monthKey] = notes;
          else delete byMonth[monthKey];
        });

        setOpenBrackets(prev => ({ ...prev, [editCatForm.bracket]: true }));
        if (newName !== oldName) flashCategory(newName);
        setActiveEditCat(null);
      };

      const handleAddBulletPoint = () => {
        if (!newBulletText.trim()) return;
        setEditCatForm(prev => ({ ...prev, notes: [...prev.notes, newBulletText.trim()] }));
        setNewBulletText("");
      };

      const handleRemoveBulletPoint = (index) => {
        setEditCatForm(prev => ({ ...prev, notes: prev.notes.filter((_, i) => i !== index) }));
      };

      const findFallback = (type) => data.categories[type].find(c => FALLBACK_NAMES.includes(c)) || t('fallbackCategory');

      // Merge one item into another: every entry, plan, note and import rule moves over; then the first item is gone.
      const mergeItems = (type, from, to) => {
        if (!from || !to || from === to) return;
        mutateWithUndo(d => {
          if (!d.categories[type].includes(from) || !d.categories[type].includes(to)) return;
          TIMELINE.forEach(({ yr, m }) => {
            const src = d.values[yr][type][from]?.[m];
            if (!src) return;
            const byCat = d.values[yr][type][to] || (d.values[yr][type][to] = {});
            const dst = byCat[m] || (byCat[m] = emptyNode());
            dst.budget += src.budget || 0;
            dst.actual += src.actual || 0;
          });
          d.tx.forEach(x => { if (x.type === type && x.cat === from) { x.cat = to; if (!x.note && from) x.note = from; } });
          const srcNotes = d.notes[type][from];
          if (srcNotes) {
            const dstNotes = d.notes[type][to] || (d.notes[type][to] = {});
            Object.entries(srcNotes).forEach(([k, list]) => { dstNotes[k] = [...(dstNotes[k] || []), ...list]; });
          }
          Object.values(d.rules || {}).forEach(r => { if (r && r.type === type && r.cat === from) r.cat = to; });
          (d.ious || []).forEach(i => { if (i.repayCat === from && (i.repayType || 'expenses') === type) i.repayCat = to; });
          d.categories[type] = d.categories[type].filter(c => c !== from);
          YEARS.forEach(yr => { delete d.values[yr][type][from]; });
          delete d.meta[type][from];
          delete d.notes[type][from];
          if (d.icons) delete d.icons[from];
        }, t('mergedToast', { from, to }));
      };
      // Items that look like the same thing (same brand/word, or words that mean the same in German/English).
      const SAME_WORDS = [['hausrat', 'furniture', 'möbel', 'moebel', 'household', 'haushalt', 'einrichtung'], ['sonstig', 'sonstiges', 'other', 'others', 'misc', 'andere', 'diverses'],
        ['kleidung', 'clothes', 'clothing', 'klamotten'], ['geschenk', 'geschenke', 'gift', 'gifts'], ['unterhaltung', 'entertainment', 'freizeit', 'fun'],
        ['lebensmittel', 'groceries', 'grocery', 'food', 'einkauf'], ['essen', 'restaurant', 'eating', 'imbiss'], ['gesundheit', 'health', 'medical', 'medizin'],
        ['haftpflicht', 'liability'], ['handy', 'mobile', 'phone'], ['savings', 'sparen', 'ersparnis', 'rücklage'], ['transport', 'tickets', 'ticket', 'öpnv'],
        ['strom', 'electricity'], ['wasser', 'water'], ['gas', 'heizung', 'heißung', 'heating'], ['papier', 'paper', 'dokumente', 'documents', 'amt']];
      const itemWords = (c) => c.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length >= 3);
      const sameKey = (w) => { const i = SAME_WORDS.findIndex(list => list.some(x => w === x || (x.length >= 5 && w.startsWith(x)))); return i >= 0 ? 'g' + i : null; };
      const lookAlikes = (type) => {
        const cats = data.categories[type];
        const info = cats.map(c => { const ws = itemWords(c); return { c, ws, keys: new Set(ws.map(sameKey).filter(Boolean)), first: ws[0] }; });
        const pairs = [];
        for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
          const a = info[i], b = info[j];
          const byMeaning = [...a.keys].some(k => b.keys.has(k));
          // One name is the other plus extra words ("amazon" / "amazon items").
          const ja = a.ws.join(' '), jb = b.ws.join(' ');
          const byBrand = ja.length >= 4 && jb.length >= 4 && (jb.startsWith(ja + ' ') || ja.startsWith(jb + ' '));
          if (byMeaning || byBrand) pairs.push([a.c, b.c]);
        }
        return pairs;
      };
      const itemWeight = (type, cat) => (data.tx || []).filter(x => x.type === type && x.cat === cat).length;

      const executeSmartDelete = (type, cat, deleteScope) => {
        const currentIdx = timelineIndex(selectedYear, selectedMonth);

        if (deleteScope === 'future_only') {
          mutate(d => {
            TIMELINE.slice(currentIdx + 1).forEach(({ yr, m }) => {
              if (d.values[yr][type][cat]?.[m]) d.values[yr][type][cat][m] = emptyNode();
            });
          });
        } else if (deleteScope === 'purge_and_merge') {
          const fallback = findFallback(type);
          if (fallback === cat) return;

          mutate(d => {
            if (!d.categories[type].includes(fallback)) {
              d.categories[type].push(fallback);
              if (type === 'incomes') {
                const preferred = 'variable_in';
                d.meta.incomes[fallback] = {
                  bracket: d.brackets.incomes.some(b => b.id === preferred) ? preferred : d.brackets.incomes[0].id,
                  mode: 'variable', oneTime: false, payDay: null
                };
              } else {
                // Keep the merged item in the same group as the one being deleted.
                d.meta.expenses[fallback] = metaForGroup(d.groups, d.meta.expenses[cat]?.bracket);
              }
            }

            TIMELINE.forEach(({ yr, m }) => {
              const src = d.values[yr][type][cat]?.[m];
              if (!src) return;
              const byCat = d.values[yr][type][fallback] || (d.values[yr][type][fallback] = {});
              const dst = byCat[m] || (byCat[m] = emptyNode());
              dst.budget += src.budget;
              dst.actual += src.actual;
            });
            d.tx.forEach(x => { if (x.type === type && x.cat === cat) x.cat = fallback; });

            const srcNotes = d.notes[type][cat];
            if (srcNotes) {
              const dstNotes = d.notes[type][fallback] || (d.notes[type][fallback] = {});
              Object.entries(srcNotes).forEach(([k, list]) => {
                dstNotes[k] = [...(dstNotes[k] || []), ...list.map(n => `${cat}: ${n}`)];
              });
            }

            d.tx.forEach(x => { if (x.type === type && x.cat === cat) x.cat = fallback; });
            d.categories[type] = d.categories[type].filter(c => c !== cat);
            YEARS.forEach(yr => { delete d.values[yr][type][cat]; });
            delete d.meta[type][cat];
            delete d.notes[type][cat];
          });
        }
        setSmartDeleteModal(null);
      };

      // Groups start open; openBrackets only remembers the ones you closed or reopened.
      const isGroupOpen = (id) => openBrackets[id] !== false;
      const toggleBracket = (id) => setOpenBrackets(prev => ({ ...prev, [id]: !isGroupOpen(id) }));
      const anyGroupClosed = data.groups.some(g => !isGroupOpen(g.id));

      const toggleAllBrackets = () => {
        const nextState = {};
        data.groups.forEach(g => { nextState[g.id] = anyGroupClosed; });
        setOpenBrackets(prev => ({ ...prev, ...nextState }));
      };

      const showToast = (msg, undoable = false) => {
        setToastMsg({ text: msg, undo: undoable });
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToastMsg(null), undoable ? 6000 : 2800);
      };

      // Changes that can be undone keep the state from just before them.
      const undoRef = useRef(null);
      const mutateWithUndo = (recipe, message) => {
        undoRef.current = dataRef.current;
        mutate(recipe);
        showToast(message, true);
      };
      const handleUndo = () => {
        if (!undoRef.current) return;
        replaceState(undoRef.current);
        undoRef.current = null;
        setToastMsg(null);
      };

      // Entries (receipts, bank lines) add to their item's monthly amount; removing one takes it off again.
      const applyTx = (d, tx, sign) => {
        const pos = dateToMonth(tx.date);
        if (!pos) return false;
        const byCat = d.values[pos.yr][tx.type][tx.cat] || (d.values[pos.yr][tx.type][tx.cat] = {});
        const node = byCat[pos.m] || (byCat[pos.m] = emptyNode());
        node.actual = Math.max(0, round2(node.actual + sign * tx.amount));
        return true;
      };
      const newTxId = () => 'tx' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const defaultTxDate = () => {
        if (monthStatus(selectedYear, selectedMonth) === 'current') return todayISO();
        return `${selectedYear}-${pad2(ALL_MONTHS.indexOf(selectedMonth) + 1)}-01`;
      };
      const monthTx = (type, cat) => (data.tx || [])
        .filter(x => x.type === type && (!cat || x.cat === cat))
        .filter(x => { const pos = dateToMonth(x.date); return pos && pos.yr === selectedYear && pos.m === selectedMonth; })
        .sort((a, b) => a.date < b.date ? 1 : -1);
      // Receipts of one item inside the budget month (payday of the month before → day before payday).
      const periodTx = (cat) => {
        const idx = timelineIndex(selectedYear, selectedMonth);
        const prev = idx > 0 ? TIMELINE[idx - 1] : null;
        const iso = (yr, m, day) => `${yr}-${pad2(ALL_MONTHS.indexOf(m) + 1)}-${pad2(day)}`;
        const from = prev ? iso(prev.yr, prev.m, payday) : '0000';
        const until = iso(selectedYear, selectedMonth, payday);
        return (data.tx || [])
          .filter(x => x.type === 'expenses' && x.cat === cat && x.date >= from && x.date < until)
          .sort((a, b) => a.date < b.date ? 1 : -1);
      };
      const whoLabel = (w) => w === 'me' ? data.members.me : w === 'partner' ? data.members.partner : w === 'joint' ? t('whoJoint') : '';
      const fmtDay = (iso) => { const [, mo, da] = iso.split('-'); return `${+da}.${+mo}.`; };

      const [lastWho, setLastWho] = useState(() => {
        const v = safeStorage.get('budget_last_who', 'joint');
        return WHO.includes(v) ? v : 'joint';
      });
      useEffect(() => { safeStorage.set('budget_last_who', lastWho); }, [lastWho]);

      const deleteTx = (id) => {
        const tx = data.tx.find(x => x.id === id);
        if (!tx) return;
        mutateWithUndo(d => {
          const cur = d.tx.find(x => x.id === id);
          if (cur) applyTx(d, cur, -1);
          d.tx = d.tx.filter(x => x.id !== id);
        }, t('txDeleted', { amount: fmtCents(tx.amount), name: tx.cat }));
      };

      // ---- Book: one quick form for every purchase or income, and a calendar of the days ----
      const [bk, setBk] = useState(() => ({
        type: 'expenses', amount: '', cat: null, date: todayISO(), account: safeStorage.get('budget_last_account', ''),
        who: lastWho, note: '', q: '', newName: '', newGroup: '', all: false, saved: 0, err: '', shop: '', parts: [], kind: 'purchase', every: 1, payDay: '', paidNow: true
      }));
      const setB = (patch) => setBk(prev => ({ ...prev, ...patch, err: '' }));
      const [calDay, setCalDay] = useState(null);
      const [calMode, setCalModeState] = useState(() => safeStorage.get('budget_cal_mode', 'month') === 'day' ? 'day' : 'month');
      const setCalMode = (v) => { setCalModeState(v); safeStorage.set('budget_cal_mode', v); };
      const [infoLang, setInfoLang] = useState(null);
      // Items used most often come first.
      const bkUsage = useMemo(() => {
        const u = {};
        // Your own entries count most, recent ones more than old ones.
        const now = Date.now();
        (data.tx || []).forEach(x => {
          const k = x.type + '|' + x.cat;
          const age = (now - new Date(x.date + 'T12:00').getTime()) / 864e5;
          u[k] = (u[k] || 0) + (age <= 14 ? 6 : age <= 45 ? 4 : 2);
        });
        // Shops and other day-to-day items first (bills are paid by standing order), then what was used lately.
        const recent = TIMELINE.slice(Math.max(0, nowIdx - 2), nowIdx + 1);
        TYPES.forEach(type => data.categories[type].forEach(cat => {
          const k = type + '|' + cat;
          if (type === 'expenses' && isReceiptItem(cat)) u[k] = (u[k] || 0) + 4;
          recent.forEach(({ yr, m }) => { if ((data.values[yr]?.[type]?.[cat]?.[m]?.actual || 0) > 0) u[k] = (u[k] || 0) + 1; });
        }));
        return u;
      }, [data, nowIdx]);
      // ---- Receipt photo: the AI reads shop, total and date and fills the form ----
      const [receiptBusy, setReceiptBusy] = useState(false);
      const shrinkImage = (file) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(img.src);
          resolve(c.toDataURL('image/jpeg', 0.82).split(',')[1]);
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
      const readReceiptPhoto = async (file) => {
        if (!file) return;
        if (!auth?.currentUser) { showToast(t('askNeedSignIn')); return; }
        setReceiptBusy(true);
        try {
          const image = await shrinkImage(file);
          const token = await auth.currentUser.getIdToken();
          const resp = await fetch('/api/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ mode: 'receipt', image, mediaType: 'image/jpeg', items: data.categories.expenses })
          });
          const r = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            const key = { not_configured: 'askErrSetup', bad_api_key: 'askErrSetup', not_allowed: 'askErrNotAllowed', not_signed_in: 'askNeedSignIn', rate_limited: 'askErrBusy' }[r.error] || 'askErrGeneric';
            showToast(t(key)); return;
          }
          if (!r.amount) { showToast(t('rcNone')); return; }
          const patch = { type: 'expenses', amount: String(r.amount).replace('.', lang === 'en' ? '.' : ','), note: r.note || '', q: '' };
          if (r.date && dateToMonth(r.date)) patch.date = r.date;
          const own = data.categories.expenses.find(c => c.toLowerCase() === (r.shop || '').toLowerCase());
          if (own) patch.cat = own;
          else if (r.category) patch.cat = r.category;
          else if (r.shop) {
            const dir = MERCHANTS.find(e => e[0].toLowerCase() === r.shop.toLowerCase());
            Object.assign(patch, { cat: '__new', newName: dir ? dir[0] : r.shop, newGroup: resolveGroup(data.groups, dir ? dir[1] : 'groceries').id });
          }
          if (patch.cat && patch.cat !== '__new' && r.shop && patch.cat.toLowerCase() !== r.shop.toLowerCase()) patch.note = [r.shop, r.note].filter(Boolean).join(' · ');
          setB(patch);
          haptic(12);
          showToast(t('rcRead', { amount: fmtCents(r.amount), shop: r.shop || '' }));
        } catch (e) {
          console.error(e);
          showToast(t(navigator.onLine ? 'askErrGeneric' : 'askErrOffline'));
        } finally {
          setReceiptBusy(false);
        }
      };

      const saveTransfer = () => {
        const amount = parseAmount(bk.amount);
        if (amount === null) { setBk(prev => ({ ...prev, err: 'amount' })); return; }
        if (!bk.from || !bk.to || bk.from === bk.to) { setBk(prev => ({ ...prev, err: 'accounts' })); return; }
        if (!dateToMonth(bk.date)) { setBk(prev => ({ ...prev, err: 'date' })); return; }
        const tr = { id: 'tr' + Date.now().toString(36), date: bk.date, amount, from: bk.from, to: bk.to, note: bk.note.trim(), moved: bk.moveBal !== false };
        const name = (id) => data.accounts.find(a => a.id === id)?.name || '';
        mutateWithUndo(d => {
          bookSavingsMove(d, tr);
          d.transfers.push(tr);
          if (tr.moved) {
            const a = d.accounts.find(x => x.id === tr.from), b2 = d.accounts.find(x => x.id === tr.to);
            if (a) a.balance = round2((a.balance || 0) - amount);
            if (b2) b2.balance = round2((b2.balance || 0) + amount);
          }
        }, t('trSaved', { amount: fmtCents(amount), from: name(tr.from), to: name(tr.to) }));
        haptic(12);
        setCalDay(bk.date);
        setBk(prev => ({ ...prev, amount: '', note: '', saved: prev.saved + 1, err: '' }));
      };
      // The savings item for moves into a savings account (expense) and back out (income).
      const ensureSavingsItem = (d, type) => {
        const existing = d.categories[type].find(c => SAVINGS_RE.test(c));
        if (existing) return existing;
        const name = type === 'expenses' ? t('savingsOutItem') : t('savingsInItem');
        d.categories[type].push(name);
        d.meta[type][name] = type === 'expenses' ? metaForGroup(d.groups, resolveGroup(d.groups, 'savings|oneoff').id, null, false)
          : { bracket: d.brackets.incomes[d.brackets.incomes.length - 1].id, mode: 'variable', oneTime: false, payDay: null };
        TIMELINE.forEach(({ yr, m }) => { const byCat = d.values[yr][type][name] || (d.values[yr][type][name] = {}); if (!byCat[m]) byCat[m] = emptyNode(); });
        return name;
      };
      const bookSavingsMove = (d, tr) => {
        const from = d.accounts.find(x => x.id === tr.from), to = d.accounts.find(x => x.id === tr.to);
        const intoSav = to?.kind === 'savings' && from?.kind !== 'savings', outOfSav = from?.kind === 'savings' && to?.kind !== 'savings';
        if (!intoSav && !outOfSav) return;
        const type = intoSav ? 'expenses' : 'incomes';
        const cat = ensureSavingsItem(d, type);
        const acct = intoSav ? from : to;
        const tx = { id: newTxId(), date: tr.date, type, cat, amount: tr.amount, who: acctWho(acct), note: (intoSav ? to : from).name, source: 'manual', account: acct?.id || null };
        d.tx.push(tx); applyTx(d, tx, +1); tr.txId = tx.id;
      };
      const acctWho = (a) => { if (!a) return null; const n = a.name.toLowerCase(), first = (x) => (x || '').trim().split(/\s+/)[0].toLowerCase();
        return /joint|gemeinsam|مشترك/.test(n) ? 'joint' : first(data.members.partner) && n.includes(first(data.members.partner)) ? 'partner' : first(data.members.me) && n.includes(first(data.members.me)) ? 'me' : null; };
      const deleteTransfer = (id) => mutateWithUndo(d => {
        const tr = d.transfers.find(x => x.id === id);
        const own = tr && tr.txId ? d.tx.find(x => x.id === tr.txId) : null;
        if (own) { applyTx(d, own, -1); d.tx = d.tx.filter(x => x.id !== own.id); }
        if (tr && tr.moved) {
          const a = d.accounts.find(x => x.id === tr.from), b2 = d.accounts.find(x => x.id === tr.to);
          if (a) a.balance = round2((a.balance || 0) + tr.amount);
          if (b2) b2.balance = round2((b2.balance || 0) - tr.amount);
        }
        d.transfers = d.transfers.filter(x => x.id !== id);
      }, t('trDeleted'));
      const saveBooking = () => {
        const amount = parseAmount(bk.amount);
        if (amount === null) { setBk(prev => ({ ...prev, err: 'amount' })); return; }
        if (!bk.cat || (bk.cat === '__new' && !bk.newName.trim())) { setBk(prev => ({ ...prev, err: 'cat' })); return; }
        if (!dateToMonth(bk.date)) { setBk(prev => ({ ...prev, err: 'date' })); return; }
        const type = bk.type;
        let cat = bk.cat;
        if (cat === '__new') cat = data.categories[type].find(c => c.toLowerCase() === bk.newName.trim().toLowerCase()) || bk.newName.trim().slice(0, 60);
        const isNew = !data.categories[type].includes(cat);
        const kind = isNew ? (bk.kind || (type === 'incomes' ? 'oneoff' : 'purchase')) : null;
        const repeating = kind === 'bill' || kind === 'sub' || kind === 'regular';
        const planned = repeating || kind === 'onebill';
        const gid = bk.newGroup || (type === 'expenses' ? groupForKind(kind || 'purchase') : '');
        const payDayNew = planned ? (parseInt(bk.payDay) >= 1 && parseInt(bk.payDay) <= 31 ? parseInt(bk.payDay) : +bk.date.slice(8, 10)) : null;
        // A planned item that isn't paid yet gets its plan only, no entry.
        const book = !planned || bk.paidNow !== false;
        // Split: the other parts go to their items, the rest stays on the main item.
        const parts = type === 'expenses' ? (bk.parts || []).map(p => ({ cat: p.cat, amount: parseAmount(p.amount) })).filter(p => p.cat && p.amount > 0) : [];
        const partSum = Math.round(parts.reduce((a2, p) => a2 + p.amount, 0) * 100) / 100;
        if (parts.length && partSum >= amount - 0.004) { setBk(prev => ({ ...prev, err: 'split' })); return; }
        const mainAmount = Math.round((amount - partSum) * 100) / 100;
        // Bought at a shop that sells everything: the shop goes into the note.
        const shop = (bk.shop || '').trim();
        const note = [shop && !bk.note.toLowerCase().includes(shop.toLowerCase()) ? shop : '', bk.note.trim()].filter(Boolean).join(' · ');
        const base = { date: bk.date, type, who: WHO.includes(bk.who) ? bk.who : null, note, source: 'manual', account: bk.account || null };
        const tx = { id: newTxId(), cat, amount: mainAmount, ...base };
        const partTx = parts.map((p, i) => ({ id: newTxId() + '_' + i, cat: p.cat, amount: p.amount, ...base }));
        mutateWithUndo(d => {
          if (isNew) {
            const dir = MERCHANTS.find(([nm]) => nm.toLowerCase() === cat.toLowerCase());
            if (dir && dir[2] && !autoIcon(cat) && !d.icons[cat]) d.icons[cat] = { kind: 'brand', text: cat.replace(/[^A-Za-z0-9ÄÖÜäöü]/g, '').slice(0, 2), bg: '#334155', fg: '#FFFFFF', logo: 'web:' + dir[2] };
            d.categories[type].push(cat);
            d.meta[type][cat] = type === 'expenses' ? metaForGroup(d.groups, gid, payDayNew, kind === 'onebill')
              : repeating ? { bracket: (d.brackets.incomes.find(b => /fix|regular|fest/i.test(b.id)) || d.brackets.incomes[0]).id, mode: 'fixed', oneTime: false, payDay: payDayNew }
              : { bracket: d.brackets.incomes[d.brackets.incomes.length - 1].id, mode: 'variable', oneTime: false, payDay: null };
            TIMELINE.forEach(({ yr, m }) => {
              const byCat = d.values[yr][type][cat] || (d.values[yr][type][cat] = {});
              if (!byCat[m]) byCat[m] = emptyNode();
            });
            // The plan: every N months from this month on, or just this month for a one-time bill.
            if (planned) {
              const p0 = dateToMonth(bk.date), i0 = timelineIndex(p0.yr, p0.m), every = Math.max(1, parseInt(bk.every) || 1);
              TIMELINE.forEach(({ yr, m }, idx) => {
                if (idx < i0 || (kind === 'onebill' ? idx !== i0 : (idx - i0) % every !== 0)) return;
                d.values[yr][type][cat][m].budget = amount;
              });
            }
          }
          if (book) {
            d.tx.push(tx);
            applyTx(d, tx, +1);
          }
          partTx.forEach(x => { if (d.categories[type].includes(x.cat)) { d.tx.push(x); applyTx(d, x, +1); } });
        }, t('bkSaved', { amount: fmtCents(amount), name: parts.length ? [cat, ...parts.map(p => p.cat)].join(' + ') : cat, date: new Date(bk.date + 'T12:00').toLocaleDateString(lang === 'en' ? 'en-US' : lang === 'ar' ? 'ar-SY-u-nu-latn' : 'de-DE', { day: 'numeric', month: 'short' }) }));
        haptic(12);
        setLastWho(bk.who);
        safeStorage.set('budget_last_account', bk.account || '');
        setCalDay(bk.date);
        if (!book) showToast(t('bkPlanned', { name: cat }));
        setBk(prev => ({ ...prev, amount: '', note: '', cat: shop ? null : isNew ? cat : prev.cat, newName: '', q: '', saved: prev.saved + 1, err: '', shop: '', parts: [], kind: 'purchase', every: 1, payDay: '', paidNow: true }));
      };

      const [editingTx, setEditingTx] = useState(null);
      const saveTxEdit = () => {
        const form = editingTx;
        const amount = parseAmount(form.amount);
        if (amount === null || !dateToMonth(form.date)) return;
        mutate(d => {
          const cur = d.tx.find(x => x.id === form.id);
          if (!cur) return;
          applyTx(d, cur, -1);
          Object.assign(cur, { amount, date: form.date, who: form.who, note: form.note.trim(), cat: form.cat });
          applyTx(d, cur, +1);
        });
        setEditingTx(null);
      };

      // "23,40", "23.40" and "1.234,50" all mean what a German receipt says.
      const parseAmount = (v) => {
        let str = String(v ?? '').trim().replace(/\s|€/g, '');
        if (str.includes(',')) str = str.replace(/\./g, '').replace(',', '.');
        const n = parseFloat(str);
        return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
      };

      // A receipt becomes an entry and adds to what the item already has that month.
      const addReceipt = (cat, amount, opts = {}) => {
        const tx = {
          id: newTxId(),
          date: opts.date && dateToMonth(opts.date) ? opts.date : defaultTxDate(),
          type: 'expenses', cat, amount,
          who: WHO.includes(opts.who) ? opts.who : lastWho,
          note: (opts.note || '').trim(),
          source: 'manual'
        };
        const gv = groupView.find(x => x.g.id === getMeta('expenses', cat).bracket);
        const lateReceipt = !!payday && isReceiptItem(cat) && +tx.date.slice(8, 10) >= payday;
        const sameMonth = !lateReceipt && (() => { const pos = dateToMonth(tx.date); return pos && pos.yr === selectedYear && pos.m === selectedMonth; })();
        const nextAfterPayday = lateReceipt ? (() => {
          const pos = dateToMonth(tx.date);
          return TIMELINE[timelineIndex(pos.yr, pos.m) + 1];
        })() : null;
        mutateWithUndo(d => {
          d.tx.push(tx);
          applyTx(d, tx, +1);
        }, (nextAfterPayday ? t('countsForNext', { month: formatMonth(nextAfterPayday.m, lang) }) + ' · ' : '') +
        t(gv?.target > 0 && sameMonth ? 'receiptAdded' : 'receiptAddedNoTarget', {
          amount: fmtCents(amount),
          name: cat,
          group: gv ? groupName(gv.g) : '',
          spent: fmtCents((gv?.spent || 0) + (sameMonth ? amount : 0)),
          target: fmtCents(gv?.target || 0)
        }));
      };

      const submitInlineReceipt = (cat) => {
        const amount = parseAmount(addAmount);
        if (amount === null) return;
        addReceipt(cat, amount);
        setAddingTo(null);
        setAddAmount("");
      };

      const [receiptDetails, setReceiptDetails] = useState({ date: '', who: 'joint', note: '' });
      const openReceiptSheet = () => {
        setReceiptAmount("");
        setReceiptHint(false);
        setReceiptDetails({ date: defaultTxDate(), who: lastWho, note: '' });
        setReceiptSheet(true);
      };

      const submitSheetReceipt = (cat) => {
        const amount = parseAmount(receiptAmount);
        if (amount === null) { setReceiptHint(true); return; }
        setLastWho(receiptDetails.who);
        addReceipt(cat, amount, receiptDetails);
        setReceiptSheet(false);
      };

      // ---- Bank import ----
      const openImport = () => setImportModal({
        step: 'pick', account: 'me', fileName: '', error: '',
        fromDate: `${selectedYear}-${pad2(ALL_MONTHS.indexOf(selectedMonth) + 1)}-01`
      });

      // Suggest where a bank line belongs: learned rule, an item named in it, or a likely group.
      const suggestFor = (line) => {
        const isRefund = /REFUND|ERSTATTUNG|RÜCKERSTATTUNG/.test(line.kind);
        const type = line.amount > 0 && !isRefund ? 'incomes' : 'expenses';
        const key = line.ruleKey || payeeKey(line.desc);
        const rule = data.rules[key];
        if (rule && rule.type === type && data.categories[type].includes(rule.cat)) return `item:${rule.cat}`;
        const low = line.desc.toLowerCase();
        const byName = data.categories[type].find(c => { const n = cleanItemName(c); return n.length >= 3 && low.includes(n); });
        if (byName) return `item:${byName}`;
        // Names rarely match exactly ("Vodafone GmbH" vs "Festnetz Vodafone"): one meaningful word is enough.
        const GENERIC = ['from', 'payment', 'transfer', 'zahlung', 'konto', 'gmbh', 'card', 'karte', 'monat', 'month', 'sonstiges', 'other'];
        const byWord = data.categories[type].find(c => cleanItemName(c).split(' ')
          .some(w => w.length >= 4 && !GENERIC.includes(w) && low.includes(w)));
        if (byWord) return `item:${byWord}`;
        // Same amount as a bill (or income) planned that month and still open, near its due day.
        if (labs.importAmount) {
          const pos = dateToMonth(line.date), amt = Math.abs(line.amount) + (type === 'expenses' ? Math.abs(line.fee || 0) : 0);
          if (pos) {
            const day = +line.date.slice(8, 10);
            const hits = data.categories[type].filter(c => {
              if (type === 'expenses' && isReceiptItem(c)) return false;
              const n = getNode(type, c, pos.yr, pos.m), pd = getMeta(type, c).payDay;
              return n.budget > 0 && Math.abs(n.budget - amt) < 0.01 && n.actual < 0.005 && (!Number.isInteger(pd) || Math.abs(pd - day) <= 4);
            });
            if (hits.length === 1) return `item:${hits[0]}`;
          }
        }
        if (line.mm) {
          if (type === 'incomes') {
            const partner = (data.members.partner || '').trim().split(/\s+/)[0].toLowerCase();
            const inRe = /allowance|stipend|sperrkonto/i.test(line.mm.cat) ? /sperrkonto|allowance|stipend|taschengeld/i
              : /salary|gehalt|lohn/i.test(line.mm.cat) ? new RegExp(`gehalt|salary|lohn${partner ? '|' + escapeRe(partner) : ''}`, 'i') : null;
            const fromAccount = /mai|mayo/i.test(line.mm.account) || (partner && line.mm.account.toLowerCase().includes(partner));
            const hits = inRe ? data.categories.incomes.filter(c => inRe.test(c)) : [];
            // Two allowances (yours and hers): pick by account.
            const pick = hits.length > 1 && partner ? (hits.find(c => fromAccount === c.toLowerCase().includes(partner)) || hits[0]) : hits[0];
            return pick ? `item:${pick}` : '';
          }
          // The category decides first; the subcategory only when the category says nothing.
          const hint = MM_HINTS.find(([re]) => re.test(line.mm.cat)) || (line.mm.sub ? MM_HINTS.find(([re]) => re.test(line.mm.sub)) : null);
          if (!hint || !data.groups.some(g => g.id === hint[1])) return '';
          const items = data.categories.expenses.filter(c => getMeta('expenses', c).bracket === hint[1]);
          const named = hint[2] ? (items.find(c => hint[2].test(c)) || data.categories.expenses.find(c => hint[2].test(c))) : null;
          if (named) return `item:${named}`;
          const group = data.groups.find(g => g.id === hint[1]);
          // A variable group can take a receipt on its first item; a bill needs the right item, so the user picks.
          if (group.kind === 'variable' && items.length) return `item:${items[0]}`;
          if (items.length === 1) return `item:${items[0]}`;
          return items.length ? '' : `new:${hint[1]}`;
        }
        if (type === 'incomes') return '';
        const hint = PAYEE_HINTS.find(([re]) => re.test(line.desc));
        if (hint && data.groups.some(g => g.id === hint[1])) return `new:${hint[1]}`;
        return '';
      };

      const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const isOwnTransfer = (line) => {
        if (line.mm) return line.kind === 'TRANSFER';
        if (/TOPUP|TOP-UP|TOP UP|AUFLADUNG/.test(line.kind) || /top-?up|aufladung/i.test(line.desc)) return true;
        if (line.kind && !/TRANSFER|ÜBERWEISUNG|UEBERWEISUNG|UMBUCHUNG|^OTHERS?$|^SONSTIGE/.test(line.kind)) return false;
        const names = [data.members.me, data.members.partner]
          .map(n => (n || '').trim().split(/\s+/)[0])
          .filter(n => n && n.length >= 2)
          .map(escapeRe);
        const own = new RegExp(`\\b(${[...names, 'joint', 'gemeinsam', 'vault', 'pocket', 'savings', 'spartasche', 'tagesgeld'].join('|')})\\b`, 'i');
        return own.test(line.desc);
      };

      const loadScript = (src) => new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) return resolve();
        const el = document.createElement('script');
        el.src = src; el.onload = resolve; el.onerror = reject;
        document.head.appendChild(el);
      });

      const handleStatementFile = async (file) => {
        if (!file) return;
        try {
          let rows;
          let pdfLines = null;
          if (/\.pdf$/i.test(file.name)) {
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
            pdfLines = readPdfStatement(await pdfToLines(await file.arrayBuffer()));
            rows = [];
          } else if (/\.xlsx?$/i.test(file.name)) {
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
            const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
            // Money Manager dates are real dates: read them unformatted so day and month don't swap.
            if (isMoneyManagerSheet(rows)) rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
          } else {
            rows = parseCsv(await file.text());
          }
          const fromMM = !pdfLines && isMoneyManagerSheet(rows);
          const lines = pdfLines || (fromMM ? readMoneyManager(rows) : readStatement(rows));
          if (!lines || !lines.length) { setImportModal(m => ({ ...m, error: t('importBadFile') })); return; }
          const seen = new Set(data.imported);
          const counts = {};
          const account = importModal.account;
          const today = todayISO();
          const whoOf = (line) => {
            // Consolidated statements say which account each table is.
            if (line.section && /joint|gemeinsam/i.test(line.section)) return 'joint';
            if (!line.mm) return account;
            const a = line.mm.account.toLowerCase();
            const partner = (data.members.partner || '').trim().split(/\s+/)[0].toLowerCase();
            if (/joint|gemeinsam/.test(a)) return 'joint';
            if (/\bmai\b|mayo/.test(a) || (partner && a.includes(partner))) return 'partner';
            return 'me';
          };
          // Already in the app as an entry with the same day and amount (typed in by hand)?
          const entered = (line) => data.tx.some(x => x.date === line.date && Math.abs(x.amount - Math.abs(line.amount)) < 0.005
            && x.type === (line.amount > 0 ? 'incomes' : 'expenses'));
          // Entries typed by hand that this statement also contains (same amount, within 2 days):
          // offered for fixing who paid and which account, from the statement.
          const claimed = new Set();
          const dayDiff = (a, b) => Math.abs((new Date(a + 'T12:00') - new Date(b + 'T12:00')) / 864e5);
          const typedMatch = (line) => {
            const type = line.amount > 0 ? 'incomes' : 'expenses', amt = Math.abs(line.amount);
            const c = data.tx.filter(x => !claimed.has(x.id) && x.type === type && x.source !== 'import' && Math.abs(x.amount - amt) < 0.005 && dayDiff(x.date, line.date) <= 2)
              .sort((a, b) => dayDiff(a.date, line.date) - dayDiff(b.date, line.date))[0];
            if (c) claimed.add(c.id);
            return c ? c.id : null;
          };
          const bankRe = /wise/i.test(file.name) ? /wise/i : /sparkasse|konto_\d/i.test(file.name) ? /sparkasse/i : /volksbank|vr/i.test(file.name) ? /volksbank|\bvr\b/i : /revolut/i;
          const first = (n) => (n || '').trim().split(/\s+/)[0].toLowerCase();
          const acctFor = (who) => {
            const personRe = who === 'joint' ? /joint|gemeinsam|مشترك/i : new RegExp(escapeRe(first(who === 'me' ? data.members.me : data.members.partner)) || '^$', 'i');
            return (data.accounts.find(a => bankRe.test(a.name) && personRe.test(a.name)) || data.accounts.find(a => personRe.test(a.name) && a.kind !== 'cash') || {}).id || '';
          };
          const prepared = lines.map((line, i) => {
            const who = whoOf(line);
            const matchId = !line.mm && !isOwnTransfer(line) && !/EXCHANGE|UMTAUSCH|TOP.?UP/.test(line.kind || '') ? typedMatch(line) : null;
            const fixAcct = acctFor(who);
            const base = line.mm ? `mm|${line.date}|${line.desc}|${line.amount}` : `${line.section && /joint/i.test(line.section) ? 'joint' : account}|${line.date}|${line.desc}|${line.amount}`;
            counts[base] = (counts[base] || 0) + 1;
            const importKey = `${base}|${counts[base]}`;
            const done = !line.state || /COMPLETED|ABGESCHLOSSEN|ERLEDIGT|AUSGEFÜHRT/.test(line.state);
            let skip = '';
            if (seen.has(importKey)) skip = 'dup';
            else if (!done) skip = 'state';
            else if (line.currency && line.currency !== 'EUR') skip = 'currency';
            else if (!dateToMonth(line.date)) skip = 'range';
            else if (line.date < importModal.fromDate) skip = 'before';
            else if (/EXCHANGE|UMTAUSCH/.test(line.kind)) skip = 'exchange';
            else if (line.date > today) skip = 'future';
            else if (entered(line)) skip = 'entered';
            // Money moved between your own accounts is neither income nor spending for the household.
            let ownTransfer = !skip && isOwnTransfer(line);
            // Money into or out of a savings pocket isn't a transfer between spending accounts: it's saving.
            let savTarget = '';
            if (ownTransfer && /saving|vault|pocket|spartasche|tagesgeld|\bfunds?\b|ersparnis|sparen/i.test(line.desc)) {
              const sType = line.amount < 0 ? 'expenses' : 'incomes';
              const sCat = data.categories[sType].find(c => SAVINGS_RE.test(c));
              if (sCat) { ownTransfer = false; savTarget = `item:${sCat}`; }
            }
            const target = skip || ownTransfer ? '' : savTarget || suggestFor(line);
            return { ...line, i, who, importKey, skip, ownTransfer, target, include: !skip && !ownTransfer && !!target, matchId, fixAcct, fix: true };
          }).sort((a, b) => a.date < b.date ? 1 : -1);
          setImportModal(m => ({ ...m, step: 'review', fileName: file.name, rows: prepared, error: '' }));
        } catch (e) {
          console.error(e);
          setImportModal(m => ({ ...m, error: t('importBadFile') }));
        }
      };

      const setImportRow = (i, patch) => setImportModal(m => ({
        ...m, rows: m.rows.map(r => r.i === i ? { ...r, ...patch } : r)
      }));

      // Fixed bills, one-time payments and incomes have a known amount; a tick sets it without an entry.
      const isTickedByHand = (d, type, cat, date) => {
        const pos = dateToMonth(date);
        if (!pos) return false;
        const meta = d.meta[type][cat];
        const group = type === 'expenses' ? d.groups.find(g => g.id === meta?.bracket) : null;
        if (type === 'expenses' && group?.kind === 'variable' && !meta?.oneTime) return false;
        const node = d.values[pos.yr][type][cat]?.[pos.m];
        if (!node || !(node.actual > 0)) return false;
        // Ticked by hand = only tick (or older typed) entries behind it, no real receipts or bank lines.
        return !d.tx.some(x => {
          if (x.type !== type || x.cat !== cat || x.source === 'tick' || x.source === 'legacy') return false;
          const p = dateToMonth(x.date);
          return p && p.yr === pos.yr && p.m === pos.m;
        });
      };

      const ensureItem = (d, type, name, groupId) => {
        const existing = d.categories[type].find(c => c.toLowerCase() === name.toLowerCase());
        if (existing) return existing;
        d.categories[type].push(name);
        d.meta[type][name] = type === 'expenses'
          ? metaForGroup(d.groups, groupId)
          : { bracket: d.brackets.incomes[d.brackets.incomes.length - 1].id, mode: 'variable', oneTime: false, payDay: null };
        TIMELINE.forEach(({ yr, m }) => {
          if (!d.values[yr][type][name]) d.values[yr][type][name] = {};
          d.values[yr][type][name][m] = emptyNode();
        });
        return name;
      };

      const runImport = () => {
        const chosen = importModal.rows.filter(r => r.include && r.target);
        if (!chosen.length) return;
        const account = importModal.account;
        mutateWithUndo(d => {
          chosen.forEach(r => {
            const isRefund = /REFUND|ERSTATTUNG|RÜCKERSTATTUNG/.test(r.kind);
            const type = r.amount > 0 && !isRefund ? 'incomes' : 'expenses';
            const gross = Math.abs(r.amount) + (type === 'expenses' ? Math.abs(r.fee || 0) : 0);
            const amount = round2(isRefund ? -Math.abs(r.amount) : gross);
            let cat;
            if (r.target.startsWith('new:')) cat = ensureItem(d, type, prettyPayee(r.desc), r.target.slice(4));
            else cat = r.target.slice(5);
            if (!d.categories[type].includes(cat)) return;
            // A bill ticked as paid by hand (no entries behind it) is replaced by the bank payment, not added to.
            if (isTickedByHand(d, type, cat, r.date)) {
              const pos = dateToMonth(r.date);
              setActualTx(d, type, cat, pos.yr, pos.m, 0);
            }
            const tx = { id: newTxId(), date: r.date, type, cat, amount, who: r.who || account, note: r.desc, source: 'import' };
            d.tx.push(tx);
            applyTx(d, tx, +1);
            d.imported.push(r.importKey);
            d.rules[r.ruleKey || payeeKey(r.desc)] = { type, cat };
          });
        }, t('importDone', { n: chosen.length }) + ' · ' + t('importThenBalance'));
        setImportModal(null);
      };

      // Paid / received toggle: ticking copies the plan, unticking clears the amount.
      // Real amounts are added in one place: the Add tab, prefilled for this item and month.
      // What a new item is, from its group: bills and subscriptions repeat, one-time bills are planned once.
      const kindForGroup = (type, gid) => {
        if (type === 'incomes') return 'regular';
        const g = data.groups.find(x => x.id === gid);
        return !g ? 'purchase' : g.kind === 'oneoff' ? 'onebill' : g.kind === 'fixed' ? (g.id === 'subs' ? 'sub' : 'bill') : 'purchase';
      };
      const groupForKind = (kind) => kind === 'sub' ? resolveGroup(data.groups, 'subs|bills').id
        : kind === 'bill' ? (data.groups.find(g => g.id === 'bills' && g.kind === 'fixed') || data.groups.find(g => g.kind === 'fixed') || data.groups[0]).id
        : kind === 'onebill' ? (data.groups.find(g => g.kind === 'oneoff') || data.groups[0]).id
        : (data.groups.find(g => g.kind === 'variable') || data.groups[0]).id;
      // "+ Add item" anywhere opens the one Add screen with a new item started.
      const startNewItem = (type, gid = null) => {
        const status = monthStatus(selectedYear, selectedMonth);
        const date = status === 'current' ? todayISO() : `${selectedYear}-${pad2(ALL_MONTHS.indexOf(selectedMonth) + 1)}-01`;
        const kind = type === 'incomes' ? 'regular' : gid ? kindForGroup(type, gid) : 'purchase';
        setB({ type, cat: '__new', newName: '', newGroup: gid || (type === 'expenses' ? groupForKind(kind) : ''), kind, every: 1, payDay: '', paidNow: kind === 'purchase' || kind === 'bill' || kind === 'sub', date, q: '', amount: '', shop: '', parts: [] });
        setView('book');
      };

      const addFor = (type, cat) => {
        const status = monthStatus(selectedYear, selectedMonth);
        const date = status === 'current' ? todayISO() : `${selectedYear}-${pad2(ALL_MONTHS.indexOf(selectedMonth) + 1)}-${pad2(Math.min(Number.isInteger(getMeta(type, cat).payDay) ? getMeta(type, cat).payDay : 1, getDaysInMonth(selectedYear, selectedMonth)))}`;
        setB({ type, cat, date, q: '', amount: '' });
        setView('book');
      };

      const showItem = (type, cat) => { haptic(6); setItemSheet({ type, cat }); };
      // Move several entries to another (or a new) item at once.
      const moveEntries = (type, ids, to, gid) => {
        const name = (to || '').trim().slice(0, 60);
        if (!name || !ids.length) return;
        const cat = data.categories[type].find(c => c.toLowerCase() === name.toLowerCase()) || name;
        mutateWithUndo(d => {
          if (!d.categories[type].includes(cat)) createItemIn(d, type, cat, gid || (data.groups.find(g => g.kind === 'variable') || data.groups[0]).id);
          ids.forEach(id => { const o = d.tx.find(x => x.id === id); if (o && o.cat !== cat) { applyTx(d, o, -1); o.cat = cat; applyTx(d, o, +1); } });
        }, t('movedToast', { n: ids.length, to: cat }));
      };
      const openEntry = (id) => {
        const x = (data.tx || []).find(e => e.id === id);
        if (!x) return;
        setEntrySheet({ origCat: x.cat, origAmount: x.amount, pick: false, q: '', newName: '', newGroup: '', moveAll: false, id: x.id, type: x.type, cat: x.cat, amount: String(x.amount).replace('.', lang === 'en' ? '.' : ','), date: x.date,
          who: x.who || 'joint', note: x.note || '', account: x.account || '', source: x.source, undated: !!x.undated });
      };
      // Entries that look like the same purchase (same item, same amount): moved together when asked.
      const sameEntries = (f) => (data.tx || []).filter(x => x.id !== f.id && x.type === f.type && x.cat === f.origCat && Math.abs(x.amount - f.origAmount) < 0.005);
      const createItemIn = (d, type, cat, gid) => {
        const dir = MERCHANTS.find(([nm]) => nm.toLowerCase() === cat.toLowerCase());
        if (dir && dir[2] && !autoIcon(cat) && !d.icons[cat]) d.icons[cat] = merchantLogoFor(dir[0]);
        d.categories[type].push(cat);
        d.meta[type][cat] = type === 'expenses' ? metaForGroup(d.groups, gid, null, false)
          : { bracket: d.brackets.incomes[d.brackets.incomes.length - 1].id, mode: 'variable', oneTime: false, payDay: null };
        TIMELINE.forEach(({ yr, m }) => { const byCat = d.values[yr][type][cat] || (d.values[yr][type][cat] = {}); if (!byCat[m]) byCat[m] = emptyNode(); });
      };
      const saveEntry = () => {
        const f = entrySheet;
        const amount = parseAmount(f.amount);
        if (amount === null || !dateToMonth(f.date)) return;
        const isNew = f.cat === '__new';
        const newName = (f.newName || '').trim().slice(0, 60);
        if (isNew && !newName) return;
        const cat = isNew ? (data.categories[f.type].find(c => c.toLowerCase() === newName.toLowerCase()) || newName) : f.cat;
        const others = f.moveAll && cat !== f.origCat ? sameEntries(f).map(x => x.id) : [];
        mutateWithUndo(d => {
          const cur = d.tx.find(x => x.id === f.id);
          if (!cur) return;
          if (!d.categories[f.type].includes(cat)) createItemIn(d, f.type, cat, f.newGroup || (data.groups.find(g => g.kind === 'variable') || data.groups[0]).id);
          others.forEach(id => { const o = d.tx.find(x => x.id === id); if (o) { applyTx(d, o, -1); o.cat = cat; applyTx(d, o, +1); } });
          applyTx(d, cur, -1);
          Object.assign(cur, { amount, date: f.date, cat, who: f.who, note: f.note.trim(), account: f.account || null,
            undated: false, source: cur.source === 'legacy' || cur.source === 'tick' ? 'manual' : cur.source });
          applyTx(d, cur, +1);
        }, t('entrySaved'));
        setEntrySheet(null);
      };

      const toggleDone = (type, cat) => {
        haptic(10);
        const node = getNode(type, cat, selectedYear, selectedMonth);
        if (node.actual > 0) updateNode(type, cat, selectedYear, selectedMonth, 'actual', 0);
        else if (node.budget > 0) updateNode(type, cat, selectedYear, selectedMonth, 'actual', node.budget);
        else setOpenItem(`${type}:${cat}`);
      };

      // A variable group's target applies from the selected month onward.
      const setGroupTarget = (gid, value) => {
        const amount = parseFloat(value);
        const startIdx = timelineIndex(selectedYear, selectedMonth);
        mutate(d => {
          if (!d.targets[gid]) d.targets[gid] = {};
          TIMELINE.forEach(({ yr, m }, idx) => {
            if (idx < startIdx) return;
            if (!d.targets[gid][yr]) d.targets[gid][yr] = {};
            d.targets[gid][yr][m] = isNaN(amount) ? 0 : amount;
          });
        });
      };

      const itemsInGroup = (gid) => data.categories.expenses.filter(c => getMeta('expenses', c).bracket === gid);

      const openGroupModal = (g = null) => {
        if (g) {
          const others = data.groups.filter(x => x.id !== g.id);
          setGroupForm({ name: groupName(g), kind: g.kind, color: g.color, moveTo: others[0]?.id || "" });
          setGroupModal({ id: g.id });
        } else {
          const used = new Set(data.groups.map(x => x.color));
          setGroupForm({ name: "", kind: "variable", color: GROUP_COLORS.find(c => !used.has(c)) || 'gray', moveTo: "" });
          setGroupModal({ id: null });
        }
      };

      // Switching a group's kind keeps the numbers: plans become the target and back.
      const convertGroupKind = (d, gid, fromKind, toKind) => {
        const cats = d.categories.expenses.filter(c => d.meta.expenses[c]?.bracket === gid);
        if (toKind === 'variable' && fromKind !== 'variable') {
          d.targets[gid] = {};
          YEARS.forEach(yr => {
            d.targets[gid][yr] = {};
            getMonthsForYear(yr).forEach(m => {
              d.targets[gid][yr][m] = cats.reduce((sum, c) => sum + (d.values[yr].expenses[c]?.[m]?.budget || 0), 0);
              cats.forEach(c => { if (d.values[yr].expenses[c]?.[m]) d.values[yr].expenses[c][m].budget = 0; });
            });
          });
        }
        if (fromKind === 'variable' && toKind !== 'variable') delete d.targets[gid];
      };

      const saveGroup = () => {
        const name = groupForm.name.trim();
        if (!name) return;
        if (!groupModal.id) {
          const id = 'g' + Date.now().toString(36);
          mutate(d => {
            d.groups.push({ id, kind: groupForm.kind, color: groupForm.color, name });
            if (groupForm.kind === 'variable') convertGroupKind(d, id, 'fixed', 'variable');
          });
          setOpenBrackets(prev => ({ ...prev, [id]: true }));
        } else {
          const gid = groupModal.id;
          mutate(d => {
            const g = d.groups.find(x => x.id === gid);
            if (!g) return;
            // Keep the built-in name translatable unless it was actually changed.
            g.name = !g.name && name === t('groups.' + gid) ? null : name;
            g.color = groupForm.color;
            if (g.kind !== groupForm.kind) {
              convertGroupKind(d, gid, g.kind, groupForm.kind);
              g.kind = groupForm.kind;
              d.categories.expenses
                .filter(c => d.meta.expenses[c]?.bracket === gid)
                .forEach(c => { d.meta.expenses[c] = metaForGroup(d.groups, gid, d.meta.expenses[c].payDay, d.meta.expenses[c].once, d.meta.expenses[c].forNext); });
            }
          });
        }
        setGroupModal(null);
      };

      const deleteGroup = () => {
        const gid = groupModal?.id;
        if (!gid || data.groups.length < 2) return;
        const moveTo = groupForm.moveTo || data.groups.find(x => x.id !== gid).id;
        mutate(d => {
          d.groups = d.groups.filter(x => x.id !== gid);
          d.categories.expenses
            .filter(c => d.meta.expenses[c]?.bracket === gid)
            .forEach(c => { d.meta.expenses[c] = metaForGroup(d.groups, moveTo, d.meta.expenses[c].payDay, d.meta.expenses[c].once || d.meta.expenses[c].oneTime, d.meta.expenses[c].forNext); });
          delete d.targets[gid];
        });
        setGroupModal(null);
      };

      // One tap: the planned amount was paid / received exactly as planned.
      const markAsPlanned = (type, cat) => {
        const node = getNode(type, cat, selectedYear, selectedMonth);
        if (node.budget > 0) updateNode(type, cat, selectedYear, selectedMonth, 'actual', node.budget);
      };

      // Re-anchor the running balance on a real bank + cash figure.
      // For the current month the user enters today's balance and we work back to the
      // start of the month using what's already recorded; for other months, the start balance.
      const balanceIsToday = !isAnnual && monthStatus(selectedYear, selectedMonth) === 'current';
      const balanceStartFromInput = () => {
        const v = parseFloat(balanceInput);
        if (isNaN(v)) return null;
        const cm = currentMetrics;
        // The bank already holds last month's late income (it counts in this month) and any
        // late income that arrived this month for next month; take both out to get the carry-over.
        // Last month's late bills were paid from that salary before this month began.
        const carried = (cm.shiftedIn || 0) - (cm.shiftedEx || 0) - (cm.lateVarPrev || 0);
        if (!balanceIsToday) return v - carried;
        return v - carried
          - (cm.actualIn - (cm.shiftedActual || 0)) + (cm.actualEx - (cm.shiftedExActual || 0) - (cm.lateVarPrev || 0))
          - (cm.arrivedForNextActual || 0) + (cm.leftForNextActual || 0) + (cm.lateVarHere || 0);
      };

      const openBalanceModal = () => {
        setBalanceInput("");
        setBalanceModal(true);
      };

      const applyBalance = () => {
        const start = balanceStartFromInput();
        if (start === null) return;
        mutate(d => {
          d.startingCapital = Math.round(start * 100) / 100;
          d.startingMonth = timelineKey(selectedYear, selectedMonth);
        });
        setBalanceModal(false);
      };

      // ---- Assistant (Claude, through the app's own server function) ----
      // A compact copy of the data: only months and items with numbers, plus the app's own monthly results.
      const buildSnapshot = () => {
        const months = {};
        TIMELINE.forEach(({ yr, m }) => {
          const entry = {};
          ['incomes', 'expenses'].forEach(type => {
            const items = {};
            data.categories[type].forEach(cat => {
              const n = getNode(type, cat, yr, m);
              if (n.budget || n.actual) items[cat] = { plan: n.budget, actual: n.actual };
            });
            if (Object.keys(items).length) entry[type] = items;
          });
          const targets = {};
          data.groups.filter(g => g.kind === 'variable').forEach(g => { const v = getTarget(g.id, yr, m); if (v) targets[g.id] = v; });
          if (Object.keys(targets).length) entry.groupTargets = targets;
          if (Object.keys(entry).length) months[`${yr}-${m}`] = entry;
        });
        const computed = forwardTimeline
          .filter(r => months[`${r.year}-${r.month}`])
          .map(r => ({
            month: `${r.year}-${r.month}`, status: monthStatus(r.year, r.month),
            startBalance: r.startBal == null ? null : round2(r.startBal),
            expectedIn: round2(r.projectedIn), expectedOut: round2(r.projectedEx),
            actualIn: round2(r.actualIn), actualOut: round2(r.actualEx),
            fixedExpected: round2(r.fixed.expected), variableAndOneTimeExpected: round2(r.flex.expected),
            endBalance: r.endProjectedBalance == null ? null : round2(r.endProjectedBalance)
          }));
        const items = {};
        ['incomes', 'expenses'].forEach(type => {
          items[type] = Object.fromEntries(data.categories[type].map(cat => {
            const meta = getMeta(type, cat);
            const g = type === 'expenses' ? data.groups.find(x => x.id === meta.bracket) : null;
            return [cat, { group: g ? `${groupName(g)} (${g.kind})` : meta.bracket, oneTime: !!meta.oneTime, dueDay: meta.payDay || null }];
          }));
        });
        return JSON.stringify({
          today: todayISO(),
          members: data.members,
          monthKeys: 'German month abbreviations: Jan Feb Mrz Apr Mai Jun Jul Aug Sep Okt Nov Dez',
          startingBalance: { amount: data.startingCapital, atStartOf: data.startingMonth },
          groups: data.groups.map(g => ({ id: g.id, name: groupName(g), kind: g.kind })),
          items, months, computed,
          loans: data.ious, savingsGoals: data.goals,
          tx: (data.tx || []).map(x => ({ date: x.date, type: x.type, item: x.cat, amount: x.amount, who: whoLabel(x.who), note: x.note || undefined })),
          log: (data.log || []).slice(-200)
        });
      };

      const sendQuestion = async () => {
        const question = askInput.trim();
        if (!question || askBusy) return;
        if (!auth?.currentUser) { setAskError(t('askNeedSignIn')); return; }
        const chat = [...askChat, { role: 'user', content: question, text: question }];
        setAskChat(chat); setAskInput(''); setAskBusy(true); setAskError('');
        try {
          const token = await auth.currentUser.getIdToken();
          const resp = await fetch('/api/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ snapshot: buildSnapshot(), messages: chat.slice(-39).map(({ role, content }) => ({ role, content })) })
          });
          const body = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            const key = { not_configured: 'askErrSetup', bad_api_key: 'askErrSetup', not_allowed: 'askErrNotAllowed', not_signed_in: 'askNeedSignIn', rate_limited: 'askErrBusy', refused: 'askErrRefused' }[body.error] || 'askErrGeneric';
            setAskError(t(key));
            setAskChat(c => c.slice(0, -1)); setAskInput(question);
            return;
          }
          setAskChat(c => [...c, { role: 'assistant', content: body.content, text: body.text + (body.truncated ? ' …' : '') }]);
        } catch (e) {
          console.error(e);
          setAskError(t(navigator.onLine ? 'askErrGeneric' : 'askErrOffline'));
          setAskChat(c => c.slice(0, -1)); setAskInput(question);
        } finally {
          setAskBusy(false);
        }
      };

      // ---- IOU / Debts ----
      // A loan can be linked to its repayment item; what was paid there counts as repaid.
      const LOAN_REPAY_NAMES = ["Rückzahlung Schwester", "Sister Repayment"];
      const repayTypeOf = (iou) => iou.repayType === 'incomes' ? 'incomes' : 'expenses';
      const repayItemOf = (iou) => {
        if (iou.repayCat && data.categories[repayTypeOf(iou)].includes(iou.repayCat)) return iou.repayCat;
        if (iou.type !== 'borrowed') return null;
        if (/schwester|sister/i.test(iou.person)) return data.categories.expenses.find(c => LOAN_REPAY_NAMES.includes(c)) || null;
        return null;
      };
      // Loans that share one repayment item: what's paid there goes to the oldest loan first.
      const loanSiblings = (iou) => {
        const cat = repayItemOf(iou);
        if (!cat) return [];
        return (data.ious || []).filter(i => repayItemOf(i) === cat && repayTypeOf(i) === repayTypeOf(iou) && !(i.settled && !i.repayCat));
      };
      const repaidOf = (iou) => {
        const cat = repayItemOf(iou);
        if (!cat) return 0;
        let left = TIMELINE.reduce((sum, { yr, m }) => sum + getNode(repayTypeOf(iou), cat, yr, m).actual, 0);
        for (const sib of loanSiblings(iou)) {
          const share = Math.min(left, parseFloat(sib.amount) || 0);
          if (sib.id === iou.id) return share;
          left -= share;
        }
        return 0;
      };
      const activeIous = useMemo(() => (data.ious || []).filter(i => !i.settled && !(repayItemOf(i) && repaidOf(i) >= (parseFloat(i.amount) || 0) - 0.005)), [data]);
      const totalBorrowed = activeIous.filter(i => i.type === 'borrowed').reduce((s, i) => s + Math.max(0, (parseFloat(i.amount) || 0) - repaidOf(i)), 0);
      const totalLent = activeIous.filter(i => i.type !== 'borrowed').reduce((s, i) => s + Math.max(0, (parseFloat(i.amount) || 0) - repaidOf(i)), 0);

      const todayLabel = () => new Date().toLocaleDateString(lang === 'en' ? 'en-US' : lang === 'ar' ? 'ar-SY-u-nu-latn' : 'de-DE', { day: '2-digit', month: 'short' });

      const handleAddIou = () => {
        if (!iouPerson.trim() || !iouAmount || isNaN(parseFloat(iouAmount))) return;
        mutate(d => {
          d.ious.push({
            id: 'iou_' + Date.now(),
            person: iouPerson.trim(),
            amount: parseFloat(iouAmount),
            type: iouType,
            date: todayLabel(),
            settled: false
          });
        });
        setIouPerson("");
        setIouAmount("");
      };

      const handleSettleIou = (id) => {
        mutateWithUndo(d => {
          const x = d.ious.find(i => i.id === id);
          if (!x) return;
          x.settled = true;
          x.repayCat = x.repayCat || repayItemOf(x) || undefined;
          dropLoanPlan(d, x, true);
        }, t('loanSettledToast'));
      };

      // For entries made by mistake: removes the debt record only, not any income or repayments.
      const handleDeleteIou = (item) => {
        if (!confirm(t('iouDeleteConfirm', { person: item.person, amount: fmt(item.amount) }))) return;
        mutate(d => {
          const x = d.ious.find(i => i.id === item.id);
          if (x) { applyLoanMoney(d, x, -1); dropLoanPlan(d, x, false); }
          d.ious = d.ious.filter(i => i.id !== item.id);
        });
      };

      // Repayment months default to the two months after the selected one, across year boundaries.
      const loanMonthOptions = useMemo(() => {
        const idx = Math.max(0, timelineIndex(selectedYear, selectedMonth));
        return TIMELINE.slice(idx);
      }, [selectedYear, selectedMonth]);
      const pickLoanMonth = (offset) => loanMonthOptions[Math.min(loanMonthOptions.length - 1, offset)];

      // ---- New loan: any person and amount, booked into its month, optional repayment plan ----
      const [newLoan, setNewLoan] = useState(null);
      const [loanBookPos, setLoanBookPos] = useState('');
      const openNewLoan = () => {
        const next = TIMELINE[Math.max(0, nowIdx) + 1] || TIMELINE[TIMELINE.length - 1];
        setNewLoan({ type: 'borrowed', person: '', amount: '', date: todayISO(), book: true, n: 2, start: `${next.yr}|${next.m}`, error: '' });
      };
      const loanSplit = (amount, n) => {
        const cents = Math.round(amount * 100), base = Math.floor(cents / n);
        return Array.from({ length: n }, (_, i) => (base + (i === n - 1 ? cents - base * n : 0)) / 100);
      };
      // ---- Loan money: the amount itself, counted as income (borrowed) or expense (lent) in one month ----
      const loanItemsFor = (person, type) => {
        const borrowed = type === 'borrowed';
        const sisterLike = /sister|schwester|أخت|اختي|أختي/i.test(person);
        const findItem = (t2, names) => data.categories[t2].find(c => names.some(n => c.toLowerCase() === n.toLowerCase()));
        return {
          moneyType: borrowed ? 'incomes' : 'expenses',
          backType: borrowed ? 'expenses' : 'incomes',
          moneyName: (borrowed && sisterLike && findItem('incomes', ['Sister Loan (Inflow)', 'Darlehen Schwester (Eingang)'])) || `${t(borrowed ? 'loanFromItem' : 'lentToItem')} ${person}`,
          backName: (borrowed && sisterLike && findItem('expenses', ['Sister Repayment', 'Rückzahlung Schwester'])) || `${t(borrowed ? 'loanRepayItem' : 'repaidByItem')} ${person}`
        };
      };
      const ensureLoanItem = (d, type, name) => {
        const existing = d.categories[type].find(c => c.toLowerCase() === name.toLowerCase());
        if (existing) return existing;
        d.categories[type].push(name);
        const g = d.groups.find(x => x.id === 'family') || d.groups.find(x => x.kind === 'oneoff') || d.groups[0];
        d.meta[type][name] = type === 'expenses' ? metaForGroup(d.groups, g.id, null, false)
          : { bracket: d.brackets.incomes[d.brackets.incomes.length - 1].id, mode: 'variable', oneTime: false, payDay: null };
        TIMELINE.forEach(({ yr, m }) => {
          const byCat = d.values[yr][type][name] || (d.values[yr][type][name] = {});
          if (!byCat[m]) byCat[m] = emptyNode();
        });
        return name;
      };
      const loanNode = (d, type, name, yr, m) => { const byCat = d.values[yr][type][name] || (d.values[yr][type][name] = {}); return byCat[m] || (byCat[m] = emptyNode()); };
      // Adds (sign 1) or takes back (sign -1) a loan's booked amount.
      const applyLoanMoney = (d, iou, sign, amount) => {
        const b = iou.booked;
        if (!b || !b.cat || !d.values[b.yr]) return;
        const v = amount ?? b.amount;
        const n = loanNode(d, b.type, b.cat, b.yr, b.m);
        const own = b.txId ? d.tx.find(x => x.id === b.txId) : null;
        if (sign > 0 && b.date && amount == null) {
          // The money arrives (or leaves) on the loan's own day, named after the person.
          const tx = { id: newTxId(), date: b.date, type: b.type, cat: b.cat, amount: round2(v), who: null, note: iou.person || '', source: 'loan', account: null };
          d.tx.push(tx); applyTx(d, tx, +1); b.txId = tx.id;
        } else if (sign < 0 && own && amount == null) {
          applyTx(d, own, -1); d.tx = d.tx.filter(x => x.id !== own.id); delete b.txId;
        } else {
          setActualTx(d, b.type, b.cat, b.yr, b.m, Math.max(0, n.actual + sign * v), 'loan');
        }
        n.budget = round2(Math.max(0, n.budget + sign * v));
      };
      // Planned repayments a loan added; taken back when the loan is deleted, and the unpaid ones when it's settled early.
      const dropLoanPlan = (d, iou, onlyOpen) => {
        if (!Array.isArray(iou.plan) || !iou.repayCat) return;
        const type = iou.repayType === 'incomes' ? 'incomes' : 'expenses';
        iou.plan = iou.plan.filter(p => {
          const idx = timelineIndex(p.yr, p.m);
          const n = d.values[p.yr]?.[type]?.[iou.repayCat]?.[p.m];
          if (!n) return false;
          if (onlyOpen && (idx < nowIdx || n.actual > 0.005)) return true;
          n.budget = round2(Math.max(0, n.budget - p.amount));
          return false;
        });
      };
      const bookLoanInto = (d, iou, pos) => {
        const { moneyType, moneyName } = loanItemsFor(iou.person, iou.type);
        const cat = ensureLoanItem(d, moneyType, moneyName);
        iou.booked = { type: moneyType, cat, yr: pos.yr, m: pos.m, amount: round2(parseFloat(iou.amount) || 0), ...(pos.date ? { date: pos.date } : {}) };
        applyLoanMoney(d, iou, 1);
      };
      // 'booked' (we know where), 'earlier' (counted before this was tracked), 'off', or 'unknown' (older loans).
      const loanMoneyState = (iou) => iou.booked && iou.booked.cat ? 'booked' : iou.booked === true ? 'earlier' : iou.booked === false ? 'off' : 'unknown';
      const bookLoanNow = (id, pos) => mutateWithUndo(d => {
        const x = d.ious.find(i => i.id === id);
        if (x) bookLoanInto(d, x, pos);
      }, t('loanBookedToast'));
      const unbookLoan = (id) => mutateWithUndo(d => {
        const x = d.ious.find(i => i.id === id);
        if (x) { applyLoanMoney(d, x, -1); x.booked = false; }
      }, t('loanUnbookedToast'));
      const markLoanCounted = (id) => mutate(d => { const x = d.ious.find(i => i.id === id); if (x) x.booked = true; });
      const nowPosLoan = () => TIMELINE[Math.max(0, nowIdx)];

      const saveNewLoan = () => {
        const f = newLoan;
        const person = f.person.trim();
        const amount = Math.round((parseFloat(String(f.amount).replace(',', '.')) || 0) * 100) / 100;
        const pos = dateToMonth(f.date);
        if (!person || amount <= 0 || !pos) { setNewLoan({ ...f, error: t('loanNeedFields') }); return; }
        const { backType, backName } = loanItemsFor(person, f.type);
        const startIdx = TIMELINE.findIndex(x => timelineKey(x.yr, x.m) === f.start);
        const parts = f.n > 0 && startIdx >= 0 ? loanSplit(amount, f.n) : [];
        mutateWithUndo(d => {
          const back = ensureLoanItem(d, backType, backName);
          const iou = {
            id: 'iou_' + Date.now(), person, amount, type: f.type, settled: false,
            date: new Date(f.date).toLocaleDateString(lang === 'en' ? 'en-US' : lang === 'ar' ? 'ar-SY-u-nu-latn' : 'de-DE', { day: '2-digit', month: 'short', year: 'numeric' }),
            repayCat: back, repayType: backType, booked: false,
            rate: f.rate ? Math.max(0, Math.min(100, parseFloat(String(f.rate).replace(',', '.')) || 0)) : null
          };
          if (f.book) bookLoanInto(d, iou, { ...pos, date: f.date });
          iou.plan = [];
          // Added to what's already planned there, never overwriting another loan's repayment.
          parts.forEach((part, i) => {
            const p = TIMELINE[startIdx + i];
            if (!p) return;
            const n = loanNode(d, backType, back, p.yr, p.m);
            n.budget = round2(n.budget + part);
            iou.plan.push({ yr: p.yr, m: p.m, amount: part });
          });
          d.ious.push(iou);
        }, t('loanAdded', { amount: fmtCents(amount), person }));
        setNewLoan(null);
      };

      const openLoanModal = () => {
        const n1 = pickLoanMonth(1);
        const n2 = pickLoanMonth(2);
        // Reuse items from an earlier booking, whichever language it was made in.
        const existingIn = data.categories.incomes.find(c => ["Darlehen Schwester (Eingang)", "Sister Loan (Inflow)"].includes(c));
        const existingOut = data.categories.expenses.find(c => ["Rückzahlung Schwester", "Sister Repayment"].includes(c));
        setLoanForm({
          lender: lang === 'de' ? "Schwester" : "Sister",
          incomeAmount: 900,
          incomeName: existingIn || (lang === 'de' ? "Darlehen Schwester (Eingang)" : "Sister Loan (Inflow)"),
          expenseName: existingOut || (lang === 'de' ? "Rückzahlung Schwester" : "Sister Repayment"),
          m1: `${n1.yr}|${n1.m}`,
          a1: 450,
          m2: `${n2.yr}|${n2.m}`,
          a2: 450
        });
        setLoanModal(true);
      };

      const handleExecuteLoanBooking = () => {
        const incName = loanForm.incomeName.trim() || "Darlehen Schwester (Eingang)";
        const expName = loanForm.expenseName.trim() || "Rückzahlung Schwester";
        const incAmt = parseFloat(loanForm.incomeAmount) || 0;
        const rep1 = parseFloat(loanForm.a1) || 0;
        const rep2 = parseFloat(loanForm.a2) || 0;

        // Sum per month so picking the same month twice doesn't drop one installment.
        const plan = {};
        plan[loanForm.m1] = (plan[loanForm.m1] || 0) + rep1;
        plan[loanForm.m2] = (plan[loanForm.m2] || 0) + rep2;

        mutate(d => {
          const ensure = (type, name, meta) => {
            if (!d.categories[type].includes(name)) {
              d.categories[type].push(name);
              d.meta[type][name] = meta;
            }
            TIMELINE.forEach(({ yr, m }) => {
              const byCat = d.values[yr][type][name] || (d.values[yr][type][name] = {});
              if (!byCat[m]) byCat[m] = emptyNode();
            });
          };

          ensure('incomes', incName, { bracket: 'variable_in', mode: 'variable', oneTime: true, payDay: null });
          const inNode = d.values[selectedYear].incomes[incName][selectedMonth];
          setActualTx(d, 'incomes', incName, selectedYear, selectedMonth, incAmt, 'loan');
          inNode.budget = incAmt;

          const oneoffGroup = d.groups.find(g => g.kind === 'oneoff') || d.groups.find(g => g.kind === 'fixed') || d.groups[0];
          ensure('expenses', expName, metaForGroup(d.groups, oneoffGroup.id));
          Object.entries(plan).forEach(([key, amt]) => {
            const [yr, m] = key.split('|');
            d.values[yr].expenses[expName][m].budget = amt;
          });

          d.ious.push({
            id: 'iou_' + Date.now(),
            repayCat: expName,
            person: loanForm.lender.trim() || "Schwester",
            amount: incAmt,
            type: 'borrowed',
            date: todayLabel(),
            settled: false
          });
        });

        setLoanModal(null);
        const [y1, mo1] = loanForm.m1.split('|');
        const [y2, mo2] = loanForm.m2.split('|');
        alert(t('loanSuccessAlert', {
          inAmount: fmt(incAmt),
          inMonth: formatMonth(selectedMonth, lang),
          a1: fmt(rep1),
          m1: `${formatMonth(mo1, lang)} ${y1}`,
          a2: fmt(rep2),
          m2: `${formatMonth(mo2, lang)} ${y2}`
        }));
      };

      // ---- Chart: created once, updated in place ----
      useEffect(() => {
        const canvas = chartRef.current;
        if (!canvas || typeof Chart === 'undefined') return;

        const months = getMonthsForYear(selectedYear);
        const chartData = {
          labels: months.map(m => formatMonth(m, lang)),
          datasets: [
            {
              label: t('incomesHeader'),
              data: months.map(m => data.categories.incomes.reduce((s, c) => s + getNode('incomes', c, selectedYear, m).actual, 0)),
              backgroundColor: '#0f7b6c',
              borderRadius: 3,
              stack: 'in'
            },
            ...data.groups.map(g => ({
              label: groupName(g),
              data: months.map(m => data.categories.expenses
                .filter(c => getMeta('expenses', c).bracket === g.id)
                .reduce((sum, c) => sum + getNode('expenses', c, selectedYear, m).actual, 0)),
              backgroundColor: GROUP_HEX[g.color] || '#787774',
              borderRadius: 2,
              stack: 'out'
            }))
          ]
        };

        const isDark = resolvedTheme === 'dark';
        const axisColor = isDark ? '#9b9a97' : '#787774';
        const options = {
          responsive: true, maintainAspectRatio: false,
          scales: {
            x: { ticks: { color: axisColor, font: { size: 10, weight: '500' } }, grid: { display: false } },
            y: { beginAtZero: true, ticks: { color: axisColor, font: { size: 9 }, callback: v => fmt(v) }, grid: { color: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' } }
          },
          plugins: {
            legend: { position: 'top', labels: { color: axisColor, usePointStyle: true, boxWidth: 6, font: { size: 10 } } }
          }
        };

        let chart = chartInstanceRef.current;
        if (chart && chart.canvas !== canvas) { chart.destroy(); chart = null; }
        if (!chart) {
          chartInstanceRef.current = new Chart(canvas.getContext('2d'), { type: 'bar', data: chartData, options });
        } else {
          chart.data = chartData;
          chart.options = options;
          chart.update('none');
        }
      }, [data, selectedYear, isAnnual, lang, resolvedTheme]);

      useEffect(() => () => chartInstanceRef.current?.destroy(), []);

      const renderPeriod = (from, until, onChange, single = false, every = null) => {
        const [a, b] = rangeIndexes(from, until);
        const step = parseInt(every) || 1;
        const payments = [];
        for (let i = a; i <= b && a !== -1; i += step) payments.push(keyLabel(timelineKey(TIMELINE[i].yr, TIMELINE[i].m)));
        return (
          <div className="space-y-1">
            <div className={`grid ${single ? 'grid-cols-1' : 'grid-cols-2'} gap-2`}>
              {[['from', from, single ? 'rangeMonth' : 'rangeFrom'], ...(single ? [] : [['until', until, 'rangeUntil']])].map(([key, value, label]) => (
                <div key={key}>
                  <label className="text-[10px] text-secondary font-medium block mb-1">{t(label)}</label>
                  <select
                    value={value}
                    onChange={(e) => onChange(key, e.target.value)}
                    className="w-full bg-subtle border border-subtle rounded px-2 py-1.5 text-xs text-primary outline-none"
                  >
                    {TIMELINE.map(({ yr, m }) => (
                      <option key={timelineKey(yr, m)} value={timelineKey(yr, m)}>{formatMonth(m, lang)} {yr}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            {!single && every !== null && (
              <div>
                <label className="text-[10px] text-secondary font-medium block mb-1">{t('repeatLabel')}</label>
                <select
                  value={step}
                  onChange={(e) => onChange('every', parseInt(e.target.value))}
                  className="w-full bg-subtle border border-subtle rounded px-2 py-1.5 text-xs text-primary outline-none"
                >
                  {REPEAT_OPTIONS.map(n => <option key={n} value={n}>{t('repeat' + n)}</option>)}
                </select>
              </div>
            )}
            {!single && step > 1 && (
              <div className="text-[10px] text-tertiary">
                {t('paymentsSummary', {
                  n: payments.length,
                  list: payments.slice(0, 5).join(', ') + (payments.length > 5 ? ', …' : '')
                })}
              </div>
            )}
            {!single && step === 1 && (
              <div className="text-[10px] text-tertiary">
                {a === b
                  ? t('rangeSummaryOne', { from: keyLabel(TIMELINE[a] ? timelineKey(TIMELINE[a].yr, TIMELINE[a].m) : from) })
                  : t('rangeSummary', {
                      n: b - a + 1,
                      from: keyLabel(timelineKey(TIMELINE[a].yr, TIMELINE[a].m)),
                      until: keyLabel(timelineKey(TIMELINE[b].yr, TIMELINE[b].m))
                    })}
              </div>
            )}
          </div>
        );
      };

      const WhoPicker = ({ value, onChange }) => (
        <div className="grid grid-cols-3 gap-1 bg-subtle p-0.5 rounded border border-subtle">
          {WHO.map(w => (
            <button
              key={w}
              type="button"
              aria-pressed={value === w}
              onClick={() => onChange(w)}
              className={`py-1 rounded text-[11px] truncate ${value === w ? 'bg-surface text-primary font-semibold shadow-sm' : 'text-secondary'}`}
            >
              {whoLabel(w)}
            </button>
          ))}
        </div>
      );

      // One entry: date, who, note, amount; tap ✎ to change it, ✕ to delete (with undo).
      const renderTxRow = (x, showItem) => {
        if (editingTx?.id === x.id) {
          const f = editingTx;
          const set = (patch) => setEditingTx(prev => ({ ...prev, ...patch }));
          return (
            <div key={x.id} className="p-2 rounded-md bg-surface border border-strong space-y-1.5">
              <div className="grid grid-cols-2 gap-1.5">
                <input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })}
                  className="bg-subtle border border-subtle rounded px-2 py-1 text-xs text-primary" aria-label={t('dateLabel')} />
                <input inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })}
                  className="bg-subtle border border-subtle rounded px-2 py-1 text-xs text-primary font-mono text-end" aria-label={t('replicateAmountLabel')} />
              </div>
              {showItem && (
                <select value={f.cat} onChange={(e) => set({ cat: e.target.value })}
                  className="w-full bg-subtle border border-subtle rounded px-2 py-1 text-xs text-primary">
                  {data.categories[x.type].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
              <WhoPicker value={f.who} onChange={(w) => set({ who: w })} />
              <input value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder={t('noteLabel')}
                className="w-full bg-subtle border border-subtle rounded px-2 py-1 text-xs text-primary" />
              <div className="flex gap-1.5">
                <button onClick={saveTxEdit} className="flex-1 py-1 rounded bg-primary text-surface text-xs font-semibold">{t('groupSave')}</button>
                <button onClick={() => setEditingTx(null)} className="flex-1 py-1 rounded bg-subtle text-secondary text-xs">{t('cancelBtn')}</button>
              </div>
            </div>
          );
        }
        return (
          <div key={x.id} className="grid grid-cols-[42px_minmax(0,1fr)_auto_auto_auto] items-center gap-1.5 px-1.5 py-1 rounded hover:bg-subtle/70 text-[11px]">
            <span className="font-mono text-tertiary">{fmtDay(x.date)}</span>
            <span className="min-w-0 truncate text-secondary">
              {showItem && <span className="text-primary font-medium">{x.cat}</span>}
              {showItem && (x.who || x.note) ? ' · ' : ''}
              {[whoLabel(x.who), x.note].filter(Boolean).join(' · ')}
              {x.source === 'import' && <span className="text-tertiary"> · ⬇</span>}
            </span>
            <span className={`font-mono ${x.type === 'incomes' ? 'text-notion-green' : 'text-primary'}`}>{fmtCents(x.amount)}</span>
            <button
              onClick={() => setEditingTx({ id: x.id, date: x.date, amount: String(x.amount).replace('.', ','), who: x.who || 'joint', note: x.note || '', cat: x.cat })}
              aria-label={t('actEdit')} className="px-1 text-tertiary hover:text-primary">✎</button>
            <button onClick={() => deleteTx(x.id)} aria-label={t('deleteCategoryBtn')} className="px-1 text-tertiary hover:text-notion-red">✕</button>
          </div>
        );
      };

      // One compact row for an income or expense item; tapping it opens its amounts and actions.
      const [iconBusy, setIconBusy] = useState(false);
      const setItemIcon = (cat, spec) => mutate(d => { if (spec) d.icons[cat] = spec; else delete d.icons[cat]; });
      // Items the app can't place by itself (no brand, no keyword, no chosen icon).
      const unmatchedItems = () => [...data.categories.expenses, ...data.categories.incomes].filter(c => !data.icons[c] && !autoIcon(c));
      const suggestIcons = async (names) => {
        const list = [...new Set(names)].slice(0, 80);
        if (!list.length) { showToast(t('iconsNone')); return; }
        if (!auth?.currentUser) { showToast(t('askNeedSignIn')); return; }
        setIconBusy(true);
        try {
          const token = await auth.currentUser.getIdToken();
          const resp = await fetch('/api/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ mode: 'icons', names: list, choices: ICON_CHOICES })
          });
          const body = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            const key = { not_configured: 'askErrSetup', bad_api_key: 'askErrSetup', not_allowed: 'askErrNotAllowed', not_signed_in: 'askNeedSignIn', rate_limited: 'askErrBusy' }[body.error] || 'askErrGeneric';
            showToast(t(key)); return;
          }
          const found = Object.entries(body.icons || {}).map(([k, v]) => [k, validIcon(v)]).filter(([k, v]) => v && list.includes(k));
          if (!found.length) { showToast(t('iconsNone')); return; }
          mutateWithUndo(d => { found.forEach(([k, v]) => { d.icons[k] = v; }); }, t('iconsDone', { n: found.length }));
        } catch (e) {
          console.error(e);
          showToast(t(navigator.onLine ? 'askErrGeneric' : 'askErrOffline'));
        } finally {
          setIconBusy(false);
        }
      };

      const iconFor = (type, cat) => {
        const own = data.icons[cat] || autoIcon(cat);
        if (own) return own;
        const gid = type === 'expenses' ? getMeta('expenses', cat).bracket : null;
        return { kind: 'symbol', icon: type === 'incomes' ? 'fa-coins' : (GROUP_ICONS[gid] || 'fa-tag') };
      };
      const tintFor = (type, cat) => {
        if (type === 'incomes') return '#10b981';
        const g = data.groups.find(x => x.id === getMeta('expenses', cat).bracket);
        return GROUP_HEX[g?.color] || '#64748b';
      };

      const renderItemRow = (type, cat, kind) => {
        const key = `${type}:${cat}`;
        const node = getNode(type, cat, selectedYear, selectedMonth);
        const meta = getMeta(type, cat);
        const notes = getNotes(type, cat);
        const isVar = kind === 'variable' && !meta.oneTime;
        const done = !isVar && node.actual > 0;
        const isOpen = openItem === key;
        const isFresh = highlightedCategory === cat;
        const shown = isVar ? periodSpent(cat, selectedYear, selectedMonth) : knownAmount(node);
        let sub;
        const entries = isVar && payday ? periodTx(cat) : monthTx(type, cat);
        if (isVar) {
          const count = entries.length + (node.receipts || 0);
          sub = count > 1 ? t('receiptsCount', { n: count })
            : count === 1 ? t('receiptsOne')
            : node.actual > 0 ? '' : t('nothingYet');
        } else if (done) {
          sub = (type === 'incomes' ? t('receivedLabel') : t('paidLabel')) +
            (node.budget > 0 && node.actual !== node.budget ? ` · ${t('planLabel')} ${fmtCents(node.budget)}` : '');
        } else if (node.budget > 0) {
          sub = type === 'incomes' ? t('expectedLabel') : meta.payDay ? t('dueOn', { day: meta.payDay }) : t('notPaidYet');
        } else {
          sub = t('groupNothingPlanned');
        }
        if (meta.oneTime && kind !== 'oneoff') sub = `${t('badgeOneTime')}${sub ? ' · ' + sub : ''}`;
        if (isForNextItem(type, cat)) {
          const nxt = TIMELINE[timelineIndex(selectedYear, selectedMonth) + 1];
          if (nxt) sub = `${t('forNextBadge', { month: formatMonth(nxt.m, lang) })}${sub ? ' · ' + sub : ''}`;
        }
        const toggleOpen = () => setOpenItem(isOpen ? null : key);

        return (
          <div key={key} className={`rounded-md ${isFresh ? 'animate-flash ring-1 ring-notion-blue' : ''}`}>
            <div className="grid grid-cols-[28px_30px_minmax(0,1fr)_auto] items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-subtle/60">
              {isVar ? (
                <button
                  onClick={() => addFor(type, cat)}
                  aria-label={t('addReceiptTo', { name: cat })}
                  className="w-7 h-7 rounded-md border border-subtle bg-surface-elevated text-secondary hover:text-primary hover:border-strong text-base leading-none"
                >
                  +
                </button>
              ) : (
                <button
                  onClick={() => toggleDone(type, cat)}
                  aria-pressed={done}
                  aria-label={t(type === 'incomes' ? 'markReceivedAria' : 'markPaidAria', { name: cat })}
                  className={`w-[22px] h-[22px] rounded-full border-[1.5px] flex items-center justify-center text-[11px] leading-none transition ${
                    done ? 'bg-notion-green border-notion-green text-white' : 'border-strong text-transparent hover:border-notion-green'
                  }`}
                >
                  ✓
                </button>
              )}
              <button onClick={() => handleOpenEditCategory(type, cat)} aria-label={t('iconLabel')} className="rounded-[9px]">
                <ItemIcon spec={iconFor(type, cat)} tint={tintFor(type, cat)} size={30} />
              </button>
              <button onClick={() => showItem(type, cat)} className="text-start min-w-0">
                <span className={`block truncate text-xs font-medium ${done ? 'text-secondary' : 'text-primary'}`}>{cat}</span>
                <span className="block truncate text-[10px] text-tertiary">
                  {sub}{notes.length > 0 ? `${sub ? ' · ' : ''}✎ ${notes.length}` : ''}
                </span>
              </button>
              <button
                onClick={() => showItem(type, cat)}
                className={`font-mono text-xs text-end ${done ? 'text-tertiary' : type === 'incomes' ? 'text-notion-green' : 'text-primary'}`}
              >
                {fmtCents(shown)}
              </button>
            </div>

            {isVar && addingTo === key && (
              <form onSubmit={(e) => { e.preventDefault(); submitInlineReceipt(cat); }} className="flex gap-1.5 ps-[5.25rem] pe-2 pb-2">
                <input
                  autoFocus
                  inputMode="decimal"
                  value={addAmount}
                  onChange={(e) => setAddAmount(e.target.value)}
                  placeholder="0,00 €"
                  aria-label={t('addReceiptTo', { name: cat })}
                  className="flex-1 min-w-0 bg-subtle border border-strong rounded px-2 py-1 font-mono text-sm text-end text-primary outline-none"
                />
                <button type="submit" className="px-3 py-1 rounded bg-primary text-surface font-semibold text-xs">{t('addBtn')}</button>
                <button type="button" onClick={() => setAddingTo(null)} className="px-2 py-1 rounded bg-subtle text-secondary text-xs">{t('cancelBtn')}</button>
              </form>
            )}

            {isOpen && (
              <div className="mx-2 mb-2 p-2 rounded-md bg-subtle/60 space-y-2">
                <div className={`grid ${isVar ? 'grid-cols-1' : 'grid-cols-2'} gap-2`}>
                  {!isVar && (
                    <label className="block">
                      <span className="text-[10px] text-secondary block mb-0.5">{t('planLabel')}</span>
                      <MoneyInput
                        value={node.budget}
                        onChange={(v) => updateNode(type, cat, selectedYear, selectedMonth, 'budget', v)}
                        className="bg-surface"
                      />
                    </label>
                  )}
                  <div className="block">
                    <span className="text-[10px] text-secondary block mb-0.5">
                      {isVar ? t('spentTotalLabel', { month: formatMonth(selectedMonth, lang) }) : type === 'incomes' ? t('receivedLabel') : t('paidLabel')}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className={`flex-1 rounded px-2 py-1 bg-surface/60 text-end font-mono text-xs font-semibold ${type === 'incomes' ? 'text-notion-green' : 'text-primary'}`}>{fmtCents(node.actual)}</span>
                      <button onClick={() => addFor(type, cat)} title={t('otAdd')} aria-label={t('otAdd')} className="w-7 h-7 rounded-lg bg-notion-blue text-white shrink-0"><i className="fa-solid fa-plus text-[11px]"></i></button>
                    </div>
                  </div>
                </div>
                {notes.length > 0 && (
                  <ul className="text-[11px] text-secondary space-y-0.5 ps-1">
                    {notes.map((n, i) => <li key={i}>• {n}</li>)}
                  </ul>
                )}
                {entries.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="text-[10px] text-secondary">{t('entriesLabel', { n: entries.length })}</div>
                    {entries.map(x => renderTxRow(x, false))}
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  <button onClick={() => handleOpenEditCategory(type, cat)}
                    className="px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 active:scale-95 transition"
                    style={{ background: tintFor(type, cat) + '22', color: tintFor(type, cat), border: `1px solid ${tintFor(type, cat)}55` }}>
                    <i className="fa-solid fa-sliders text-[10px]"></i>{t('actEditAll')}
                  </button>
                  <button onClick={() => setSmartDeleteModal({ type, cat })} className="px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 text-notion-red flex items-center gap-1.5 active:scale-95 transition">
                    <i className="fa-solid fa-trash-can text-[10px]"></i>{t('deleteCategoryBtn')}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      };

      const KIND_PILL = {
        fixed: 'bg-notion-tagBlue text-notion-blue',
        variable: 'bg-notion-tagAmber text-amber-700 dark:text-amber-400',
        oneoff: 'bg-notion-tagPurple text-purple-700 dark:text-purple-400'
      };
      const kindLabel = (kind) => kind === 'fixed' ? t('badgeFixed') : kind === 'variable' ? t('badgeVariable') : t('badgeOneTime');

      const renderGroup = (gv) => {
        const { g } = gv;
        const hex = GROUP_HEX[g.color] || GROUP_HEX.gray;
        const open = isGroupOpen(g.id);
        const isVar = g.kind === 'variable';
        // Shops count only when something was spent this month (an old plan amount on a shop means nothing);
        // bills count when planned or paid.
        const hasAmount = (i) => isVar ? i.node.actual > 0 : (i.node.budget > 0 || i.node.actual > 0);
        // Only items with a plan or an amount this month are shown; the rest is one tap away.
        const revealed = !!showEmpty[g.id];
        const emptyItems = gv.items.filter(i => !hasAmount(i) && !i.once);
        const visible = gv.items.filter(i => hasAmount(i) || (revealed && !i.once));
        const hidden = emptyItems.length;
        let amount, sub, fill, over = false;
        if (isVar) {
          amount = fmtCents(gv.spent);
          over = gv.target > 0 && gv.spent > gv.target;
          sub = gv.target <= 0 ? t('groupNoTarget')
            : over ? t('groupOverSub', { amount: fmtCents(gv.spent - gv.target), target: fmt(gv.target) })
            : t('groupTargetSub', { target: fmt(gv.target), left: fmtCents(gv.target - gv.spent) });
          fill = gv.target > 0 ? Math.min(100, (gv.spent / gv.target) * 100) : 0;
        } else {
          amount = fmtCents(gv.total);
          sub = gv.n === 0 ? t('groupNothingPlanned')
            : gv.open > 0 ? t('groupPaidSub', { n: gv.nPaid, m: gv.n, amount: fmtCents(gv.open) })
            : t('groupAllPaid');
          fill = gv.total > 0 ? Math.min(100, (gv.paid / gv.total) * 100) : 0;
        }

        return (
          <section key={g.id} className="rounded-2xl border border-subtle bg-surface overflow-hidden">
            <div className="flex items-start gap-1 pe-2">
              <button
                onClick={() => toggleBracket(g.id)}
                aria-expanded={open}
                className="flex-1 min-w-0 grid grid-cols-[10px_minmax(0,1fr)_auto] gap-3 items-center text-start ps-3.5 pt-3 pb-2"
              >
                <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: hex }}></span>
                <span className="flex items-center gap-1.5 flex-wrap min-w-0">
                  <span className="text-sm font-semibold text-primary break-words min-w-0">{groupName(g)}</span>
                  <span className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${KIND_PILL[g.kind]}`}>{kindLabel(g.kind)}</span>
                  <span className="text-[10px] text-tertiary">{t('itemsCount', { n: gv.items.length })}</span>
                  <span className={`text-[10px] text-tertiary inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
                </span>
                <span className="text-end">
                  <span className="block font-mono text-sm font-semibold text-primary">{amount}</span>
                  <span className={`block text-[10px] ${over ? 'text-notion-red' : 'text-secondary'}`}>{sub}</span>
                </span>
              </button>
              <button
                onClick={() => openGroupModal(g)}
                aria-label={t('groupDialogEdit')}
                title={t('groupDialogEdit')}
                className="mt-3 w-7 h-7 rounded text-tertiary hover:text-primary hover:bg-subtle shrink-0 leading-none"
              >
                ⋯
              </button>
            </div>
            <div className="pe-3.5 pb-3 ps-9">
              <div className="h-1.5 rounded-full bg-subtle overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${fill}%`, background: over ? '#e03e3e' : hex }}></div>
              </div>
            </div>

            <div className={`fold ${open ? '' : 'closed'}`} aria-hidden={!open}><div>
              <div className="border-t border-subtle p-1.5 space-y-0.5">
                {isVar && (
                  <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <div className="min-w-0">
                      <span className="text-[11px] font-medium text-primary block" title={t('monthlyTargetHint', { month: monthLabel(selectedYear, selectedMonth) })}>{t('monthlyTarget')}</span>
                    </div>
                    <MoneyInput
                      value={gv.target}
                      onChange={(v) => setGroupTarget(g.id, v)}
                      className="w-28 shrink-0"
                      aria-label={`${groupName(g)} ${t('monthlyTarget')}`}
                    />
                  </div>
                )}
                {visible.map(i => renderItemRow('expenses', i.cat, g.kind))}
                {visible.length === 0 && hidden === 0 && <p className="px-2 py-1.5 text-[11px] text-tertiary">{t('groupNothingPlanned')}</p>}
                {isVar && revealed && (() => {
                  const existing = new Set(data.categories.expenses.map(c => c.toLowerCase()));
                  const ideas = (STORE_SUGGESTIONS[g.id] || []).filter(n => !existing.has(n.toLowerCase()));
                  if (!ideas.length) return null;
                  return (
                    <div className="flex flex-wrap items-center gap-1.5 px-2 pt-1.5">
                      <span className="text-[10px] text-tertiary">{t('quickStores')}</span>
                      {ideas.map(n => (
                        <button
                          key={n}
                          onClick={() => handleCreateCategory('expenses', n, g.id, 'variable', 0, false, timelineKey(selectedYear, selectedMonth))}
                          className="px-2 py-0.5 rounded-full border border-dashed border-strong text-[11px] text-secondary hover:text-primary hover:border-primary"
                        >
                          + {n}
                        </button>
                      ))}
                    </div>
                  );
                })()}
                <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-1 text-[11px]">
                  {hidden > 0 ? (
                    <button onClick={() => setShowEmpty(prev => ({ ...prev, [g.id]: !revealed }))} className="text-tertiary hover:text-primary">
                      <i className={`fa-solid ${revealed ? 'fa-eye-slash' : 'fa-eye'} me-1 text-[10px]`}></i>{revealed ? t('hideEmpty') : t('emptyItems', { n: hidden })}
                    </button>
                  ) : <span></span>}
                  <button onClick={() => startNewItem('expenses', g.id)} className="text-notion-blue font-medium hover:underline">
                    {t('addItemShort')}
                  </button>
                </div>
              </div>
            </div></div>
          </section>
        );
      };

      const chartBox = (
        <div className="rounded-lg border border-subtle bg-surface p-3">
          <div className="h-[180px] relative w-full">
            <canvas ref={chartRef}></canvas>
          </div>
        </div>
      );

      const syncIcon = !user ? 'fa-hard-drive'
        : syncStatus === 'pending' ? 'fa-cloud-arrow-up'
        : syncStatus === 'error' ? 'fa-triangle-exclamation'
        : 'fa-cloud';
      const syncLabel = user ? t('syncStatus_' + syncStatus) : t('syncLocalOnly');

      const totalProjIn = yearRows.reduce((s, r) => s + r.projectedIn, 0);
      const totalProjNet = yearRows.reduce((s, r) => s + r.projectedNet, 0);
      const savingsRate = totalProjIn > 0 ? totalProjNet / totalProjIn : null;

      const renderEntries = (inline = false) => {
            const all = [...monthTx('expenses'), ...monthTx('incomes')].sort((a, b) => a.date < b.date ? 1 : -1);
            const shown = txWhoFilter === 'all' ? all : all.filter(x => x.who === txWhoFilter);
            const spentBy = (w) => all.filter(x => x.type === 'expenses' && x.who === w).reduce((sum, x) => sum + x.amount, 0);
            return (
              <Modal inline={inline} size="max-w-lg" onClose={() => { setTxModal(false); setEditingTx(null); }} title={<><span>📋</span><span>{t('txModalTitle', { month: monthLabel(selectedYear, selectedMonth) })}</span></>}>
                <div className="space-y-1">
                  <div className="text-[10px] text-secondary">{t('whoPaidTitle')}</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {WHO.map(w => (
                      <div key={w} className="p-2 rounded bg-subtle">
                        <div className="text-[10px] text-secondary truncate">{whoLabel(w)}</div>
                        <div className="font-mono text-sm font-semibold text-primary">{fmtCents(spentBy(w))}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {['all', ...WHO].map(w => (
                    <button
                      key={w}
                      onClick={() => setTxWhoFilter(w)}
                      aria-pressed={txWhoFilter === w}
                      className={`px-2.5 py-1 rounded-full text-[11px] border ${txWhoFilter === w ? 'border-primary text-primary font-semibold' : 'border-subtle text-secondary'}`}
                    >
                      {w === 'all' ? t('filterAll') : whoLabel(w)}
                    </button>
                  ))}
                </div>
                {shown.length === 0 ? (
                  <p className="text-[11px] text-tertiary">{t('txEmpty')}</p>
                ) : (
                  <div className={`space-y-0.5 ${inline ? '' : 'max-h-[50vh] overflow-y-auto'}`}>{shown.map(x => renderTxRow(x, true))}</div>
                )}
              </Modal>
            );
      };

      const renderHistory = (inline = false) => {
            const monthKey = `${selectedYear}|${selectedMonth}`;
            const monthIso = `${selectedYear}-${pad2(ALL_MONTHS.indexOf(selectedMonth) + 1)}`;
            const inMonth = (e) => e.p === monthKey || (e.d && e.d.slice(0, 7) === monthIso);
            const all = [...(data.log || [])].reverse();
            const shown = logScope === 'month' ? all.filter(inMonth) : all;
            const kindLabel = (e) => {
              const where = e.p && e.p !== monthKey && e.p.includes('|') ? ` (${monthLabel(parseInt(e.p), e.p.split('|')[1])})` : '';
              switch (e.k) {
                case 'plan': return [`${e.c}${where}`, t('logPlan'), `${fmtCents(e.o)} → ${fmtCents(e.n)}`];
                case 'done': return [`${e.c}${where}`, t(e.ty === 'incomes' ? 'logReceived' : 'logPaid'), `${fmtCents(e.o)} → ${fmtCents(e.n)}`];
                case 'tx+': return [e.c, t('logTxAdd', { day: fmtDay(e.d) }), `${e.ty === 'incomes' ? '+' : '−'} ${fmtCents(e.a)}`];
                case 'tx-': return [e.c, t('logTxDel', { day: fmtDay(e.d) }), `${fmtCents(e.a)}`];
                case 'tx~': return [e.c, t('logTxEdit', { day: fmtDay(e.d) }), `${fmtCents(e.o)} → ${fmtCents(e.n)}`];
                case 'start': return [t('logStart'), e.p ? monthLabel(parseInt(e.p), e.p.split('|')[1]) : '', `${fmtCents(e.o)} → ${fmtCents(e.n)}`];
                case 'bulk': return [t('logBulk', { n: e.n }), '', ''];
                default: return [e.k, '', ''];
              }
            };
            const days = [];
            shown.forEach(e => {
              const day = new Date(e.t).toLocaleDateString(lang === 'en' ? 'en-GB' : lang === 'ar' ? 'ar-SY-u-nu-latn' : 'de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
              if (!days.length || days[days.length - 1].day !== day) days.push({ day, items: [] });
              days[days.length - 1].items.push(e);
            });
            return (
              <Modal inline={inline} size="max-w-lg" onClose={() => setLogModal(false)} title={<><span>🕓</span><span>{t('logTitle')}</span></>}>
                <div className="grid grid-cols-2 gap-1 bg-subtle p-0.5 rounded border border-subtle text-[11px]">
                  {['month', 'all'].map(sc => (
                    <button key={sc} aria-pressed={logScope === sc} onClick={() => setLogScope(sc)}
                      className={`py-1 rounded ${logScope === sc ? 'bg-surface text-primary font-semibold shadow-sm' : 'text-secondary'}`}>
                      {sc === 'month' ? monthLabel(selectedYear, selectedMonth) : t('logAll')}
                    </button>
                  ))}
                </div>
                <div className={`space-y-3 ${inline ? '' : 'max-h-[60vh] overflow-y-auto'}`}>
                  {days.length === 0 && <p className="text-[11px] text-tertiary p-2">{t('logEmpty')}</p>}
                  {days.map(g => (
                    <div key={g.day}>
                      <div className="text-[10px] uppercase tracking-wide font-semibold text-secondary mb-1">{g.day}</div>
                      <div className="divide-y divide-subtle border border-subtle rounded">
                        {g.items.map((e, i) => {
                          const [what, action, amount] = kindLabel(e);
                          const time = new Date(e.t).toLocaleTimeString(lang === 'en' ? 'en-GB' : lang === 'ar' ? 'ar-SY-u-nu-latn' : 'de-DE', { hour: '2-digit', minute: '2-digit' });
                          return (
                            <div key={e.t + i} className="flex items-baseline justify-between gap-2 px-2 py-1.5 text-[11px]">
                              <div className="min-w-0">
                                <div className="text-primary truncate">{what}</div>
                                <div className="text-tertiary">{time}{e.by ? ` · ${e.by}` : ''}{action ? ` · ${action}` : ''}</div>
                              </div>
                              <span className="font-mono text-primary shrink-0">{amount}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-tertiary">{t('logNote', { n: LOG_MAX })}</p>
              </Modal>
            );
      };

      const renderSummary = (inline = false) => (
            <Modal
              inline={inline}
              size="max-w-lg"
              onClose={() => setBreakdownModal(false)}
              title={<><span>🧾</span><span>{t('breakdownTitle', { month: formatMonth(selectedMonth, lang), year: selectedYear })}</span></>}
            >
              {[
                ['incomes', monthlyReceipt.incomeItems, t('breakdownIncomes', { total: fmt(monthlyReceipt.incomeItems.reduce((sum, i) => sum + i.actual, 0)) }), 'text-notion-green'],
                ['expenses', monthlyReceipt.expenseItems, t('breakdownExpenses', { total: fmt(currentMetrics.actualEx) }), 'text-notion-red']
              ].map(([type, items, heading, color]) => (
                <div key={type} className="space-y-1.5 pt-1">
                  <div className={`font-semibold ${color} border-b border-subtle pb-1`}>{heading}</div>
                  {items.length === 0 ? (
                    <p className="text-tertiary italic text-[11px]">{t('noItemsInBreakdown')}</p>
                  ) : (
                    items.map(item => (
                      <div key={item.cat} className="flex items-center justify-between gap-2 p-1.5 rounded bg-subtle">
                        <span className="font-medium text-primary truncate">{item.cat}</span>
                        <span className={`w-28 text-end font-mono font-semibold shrink-0 ${color}`}>{fmtCents(item.actual)}</span>
                      </div>
                    ))
                  )}
                </div>
              ))}

              <div className="p-3 rounded-lg bg-surface-elevated border border-subtle flex items-center justify-between gap-2 font-mono font-bold text-sm">
                <span>{t('breakdownNetResult')}</span>
                <span className={currentMetrics.actualNet >= 0 ? 'text-notion-green' : 'text-notion-red'}>
                  {fmt(currentMetrics.actualNet)}
                </span>
              </div>

              {!inline && (
                <button onClick={() => setBreakdownModal(false)} className="w-full py-2 bg-primary text-surface font-semibold rounded text-xs">
                  {t('closeBtn')}
                </button>
              )}
            </Modal>
      );

      // ---- Layout helpers ----
      const toggleCollapsed = (id) => setCollapsed(prev => ({ ...prev, [id]: !prev[id] }));
      const dismiss = (id) => setDismissed(prev => ({ ...prev, [id]: true }));
      // A card with a title row; it can fold away, and notices can be dismissed for good.
      const panel = (o, body) => {
        if (o.dismissible && dismissed[o.id]) return null;
        const foldable = o.collapsible !== false;
        const isCol = foldable && (o.id in collapsed ? !!collapsed[o.id] : !!o.defaultCollapsed);
        const warn = o.tone === 'warn';
        return (
          <section key={o.id} className={`rounded-2xl border ${warn ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-subtle bg-surface'} ${o.className || ''}`}>
            <div className="flex items-center gap-2 ps-4 pe-2 py-3">
              <button type="button" onClick={foldable ? () => setCollapsed(prev => ({ ...prev, [o.id]: !isCol })) : undefined} aria-expanded={!isCol}
                className={`flex-1 min-w-0 flex items-center gap-2.5 text-start ${foldable ? '' : 'cursor-default'}`}>
                {o.icon && (
                  <span className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center text-[12px] ${warn ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-subtle text-secondary'}`}>
                    <i className={`fa-solid ${o.icon}`}></i>
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-primary truncate">{o.title}</span>
                  {o.sub && <span className="block text-[11px] text-secondary truncate">{o.sub}</span>}
                </span>
                {foldable && <i className={`fa-solid fa-chevron-down text-[10px] text-tertiary transition-transform ${isCol ? '-rotate-90' : ''}`}></i>}
              </button>
              {o.right}
              {o.dismissible && (
                <button type="button" onClick={() => dismiss(o.id)} aria-label={t('dismiss')} title={t('dismiss')}
                  className="w-7 h-7 shrink-0 rounded-full text-tertiary hover:text-primary hover:bg-subtle">
                  <i className="fa-solid fa-xmark text-xs"></i>
                </button>
              )}
            </div>
            {foldable ? (
              <div className={`fold ${isCol ? 'closed' : ''}`} aria-hidden={isCol}>
                <div><div className="px-4 pb-4">{o.toolbar && <div className="mb-3">{o.toolbar}</div>}{body}</div></div>
              </div>
            ) : <div className="px-4 pb-4">{o.toolbar && <div className="mb-3">{o.toolbar}</div>}{body}</div>}
          </section>
        );
      };

      // ---- Month navigation ----
      const curIdx = timelineIndex(selectedYear, selectedMonth);
      const goMonth = (pos) => {
        if (!pos) return;
        const to = timelineIndex(pos.yr, pos.m);
        if (to !== curIdx) { haptic(6); setAnim(to > curIdx ? 'next' : 'prev'); }
        setSelectedYear(pos.yr); setSelectedMonth(pos.m); setMonthPicker(false);
      };
      const setAllGroups = (open) => setOpenBrackets(prev => ({ ...prev, ...Object.fromEntries(data.groups.map(g => [g.id, open])) }));

      // Touch: swipe sideways to change month, pinch on the month page to fold or unfold all groups.
      const touchRef = useRef(null);
      const pinchDist = (tl) => Math.hypot(tl[0].clientX - tl[1].clientX, tl[0].clientY - tl[1].clientY);
      const onTouchStart = (e) => {
        if (e.touches.length === 2) { touchRef.current = { pinch: pinchDist(e.touches) }; return; }
        if (e.touches.length !== 1 || e.target.closest('input, textarea, select, [data-noswipe]')) { touchRef.current = null; return; }
        touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
      };
      const onTouchMove = (e) => {
        const st = touchRef.current;
        if (!st || !st.pinch || e.touches.length !== 2 || view !== 'month') return;
        const r = pinchDist(e.touches) / st.pinch;
        if (r < 0.72) { setAllGroups(false); haptic(14); touchRef.current = { done: true }; }
        else if (r > 1.38) { setAllGroups(true); haptic(14); touchRef.current = { done: true }; }
      };
      const onTouchEnd = (e) => {
        const st = touchRef.current; touchRef.current = null;
        if (!st || st.pinch || st.done || !(view === 'overview' || view === 'month' || view === 'activity')) return;
        const tch = e.changedTouches[0];
        const dx = tch.clientX - st.x, dy = tch.clientY - st.y;
        if (Date.now() - st.t > 600 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
        const forward = (dx < 0) !== (lang === 'ar');
        goMonth(TIMELINE[curIdx + (forward ? 1 : -1)]);
      };

      // ---- Accounts: real balances per bank account and cash ----
      const newAccountId = () => 'acc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const setupAccounts = () => mutate(d => {
        const me = data.members.me, partner = data.members.partner;
        const mk = (name, kind) => ({ id: newAccountId(), name, kind, balance: 0, updated: null });
        d.accounts = [
          mk(`Revolut ${me}`, 'main'), mk(`Revolut ${partner}`, 'main'), mk('Revolut Joint', 'main'),
          mk(`Wise ${me}`, 'gateway'), mk(`Wise ${partner}`, 'gateway'), mk('Sparkasse', 'gateway'),
          mk(t('accountCash'), 'cash')
        ];
      });
      const addAccount = (kind) => mutate(d => { d.accounts.push({ id: newAccountId(), name: t('accountName'), kind, balance: 0, updated: null }); });
      const updateAccount = (id, patch) => mutate(d => { const a = d.accounts.find(x => x.id === id); if (a) Object.assign(a, patch); });
      const removeAccount = (id) => mutateWithUndo(d => { d.accounts = d.accounts.filter(x => x.id !== id); }, t('accountRemoved'));
      // Savings accounts (Revolut Savings, Tagesgeld …) hold money set aside: not part of what you can spend.
      const accountsTotal = round2(data.accounts.filter(a => a.kind !== 'savings').reduce((sum, a) => sum + (a.balance || 0), 0));
      const savingsTotal = round2(data.accounts.filter(a => a.kind === 'savings').reduce((sum, a) => sum + (a.balance || 0), 0));
      const nowRow = nowIdx >= 0 ? forwardTimeline[nowIdx] : null;
      // Entries dated after today (a salary ticked early, a bill booked ahead) aren't in the bank yet.
      const futureSplit = useMemo(() => {
        if (!labs.nowToday) return { inn: 0, out: 0 };
        const today = todayISO(), prefix = today.slice(0, 8);
        const later = (data.tx || []).filter(x => x.date.startsWith(prefix) && x.date > today && x.source !== 'tick');
        return { inn: round2(later.filter(x => x.type === 'incomes').reduce((a2, x) => a2 + x.amount, 0)), out: round2(later.filter(x => x.type === 'expenses').reduce((a2, x) => a2 + x.amount, 0)) };
      }, [data.tx, labs.nowToday]);
      const futureNet = round2(futureSplit.inn - futureSplit.out);
      const appNow = nowRow && nowRow.startBal != null ? round2(nowRow.startBal + nowRow.actualIn - nowRow.actualEx - futureNet) : null;
      // Each account: the balance you last typed in, plus what was booked to it since that day.
      const accountCheck = useMemo(() => {
        const today = todayISO();
        return data.accounts.map(a => {
          if (!a.updated) return { a, since: null };
          const since = (data.tx || []).filter(x => x.account === a.id && x.date > a.updated && x.date <= today);
          const delta = round2(since.reduce((sum, x) => sum + (x.type === 'incomes' ? x.amount : -x.amount), 0));
          return { a, since, delta, expected: round2((a.balance || 0) + delta) };
        });
      }, [data.accounts, data.tx]);

      // ---- Money health: emergency fund, savings rate, needs vs wants, yearly costs, debts ----
      const DEFAULT_WANTS = { leisure: true, subs: true };
      const isWantGroup = (gid) => (gid in data.health.wants ? data.health.wants[gid] : !!DEFAULT_WANTS[gid]);
      const SAVINGS_RE = /saving|spar(?!kasse)|ersparnis|ادخار|توفير/i;
      const LOAN_MONEY_RE = /loan|darlehen|verliehen|lent to|rückzahlung|repayment|دين|سداد|إقراض/i;
      const FEE_RE = /sparkasse|volksbank|gebühr|\bfees?\b|kontof|bank/i;
      const health = useMemo(() => {
        if (nowIdx < 0) return null;
        const pos = TIMELINE[nowIdx];
        const past = TIMELINE.slice(0, nowIdx).filter(({ yr, m }) => monthStatus(yr, m) === 'past');
        const groupOfCat = (cat) => data.groups.find(g => g.id === getMeta('expenses', cat).bracket);
        const loanItems = new Set([...(data.ious || []).map(i => repayItemOf(i)), ...data.categories.expenses.filter(c => LOAN_MONEY_RE.test(c))].filter(Boolean));
        const incomeOk = (c) => !SAVINGS_RE.test(c) && !LOAN_MONEY_RE.test(c);
        // Day-to-day spending: everything except moving money to savings and paying back loans.
        const spendOk = (c) => !SAVINGS_RE.test(c) && !loanItems.has(c);
        const sumIn = ({ yr, m }) => data.categories.incomes.filter(incomeOk).reduce((s, c) => s + getNode('incomes', c, yr, m).actual, 0);
        const sumOut = ({ yr, m }, ok = spendOk) => data.categories.expenses.filter(ok).reduce((s, c) => s + getNode('expenses', c, yr, m).actual, 0);
        const regular = (c) => { const g = groupOfCat(c); return spendOk(c) && g && g.kind !== 'oneoff' && !getMeta('expenses', c).oneTime; };
        // Core costs: regular needs (rent, bills, insurance, groceries …), averaged over the last 3 finished months.
        const coreOf = (p) => sumOut(p, (c) => regular(c) && !isWantGroup(groupOfCat(c).id));
        const recent = past.slice(-3);
        const core = recent.length ? recent.reduce((s, p) => s + coreOf(p), 0) / recent.length : coreOf(pos);
        const hasAccounts = data.accounts.some(a => a.updated);
        const money = hasAccounts ? accountsTotal + savingsTotal : appNow;
        const months = core > 0 && money != null ? money / core : null;
        // Savings rate per finished month (plus this month so far).
        const rates = [...past.slice(-5), pos].map(p => {
          const income = sumIn(p), spent = sumOut(p);
          return { ...p, income, spent, rate: income > 0 ? (income - spent) / income : null, now: p === pos };
        });
        // Needs vs wants, regular spending only.
        const wantsOf = (p) => {
          const total = sumOut(p, regular);
          const wants = sumOut(p, (c) => regular(c) && isWantGroup(groupOfCat(c).id));
          return { ...p, total, wants, share: total > 0 ? wants / total : null };
        };
        const wantRows = [...past.slice(-3), pos].map(wantsOf);
        const shares = wantRows.slice(0, -1).map(r => r.share).filter(x => x != null);
        const rising = shares.length >= 3 && shares[1] > shares[0] && shares[2] > shares[1];
        // Regular costs per year (bills, subscriptions, insurance). Items paid every few months
        // (radio fee, bank fees …) are counted by how often they really come.
        const CYCLES = [1, 2, 3, 4, 6, 12];
        const yearly = data.categories.expenses.filter(c => { const g = groupOfCat(c); return g && g.kind === 'fixed' && !getMeta('expenses', c).oneTime && spendOk(c); })
          .map(c => {
            const lo = Math.max(0, nowIdx - 12), hi = Math.min(TIMELINE.length - 1, nowIdx + 12);
            const hits = [];
            for (let i = lo; i <= hi; i++) {
              const p = TIMELINE[i], n = getNode('expenses', c, p.yr, p.m);
              const v = i < nowIdx ? n.actual : knownAmount(n);
              if (v > 0) hits.push({ i, v });
            }
            if (!hits.length) return null;
            const gaps = hits.slice(1).map((x, k) => x.i - hits[k].i).sort((x, y) => x - y);
            const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12;
            const every = CYCLES.reduce((best, cyc) => Math.abs(cyc - median) < Math.abs(best - median) ? cyc : best, 1);
            const next = hits.find(x => x.i >= nowIdx) || hits[hits.length - 1];
            // Ended: nothing planned ahead and the last payment is older than one cycle.
            if (next.i < nowIdx && nowIdx - next.i > every) return null;
            const times = 12 / every;
            return { cat: c, amount: next.v, every, times, monthly: next.v / every, year: next.v * times, gid: groupOfCat(c).id };
          }).filter(Boolean).sort((a, b) => b.year - a.year);
        const subsYear = yearly.filter(x => x.gid === 'subs').reduce((s, x) => s + x.year, 0);
        // Bank fees over the last 12 months.
        const last12 = [...past.slice(-11), pos];
        const fees = data.categories.expenses.filter(c => FEE_RE.test(c))
          .map(c => ({ cat: c, total: last12.reduce((s, p) => s + getNode('expenses', c, p.yr, p.m).actual, 0) })).filter(x => x.total > 0);
        // Saving first: share of this month's expected income, and what's gone to savings so far.
        const incomeNow = data.categories.incomes.filter(incomeOk).reduce((s, c) => s + expectedIncome(getNode('incomes', c, pos.yr, pos.m)), 0);
        const setAside = data.health.savePct > 0 ? round2(incomeNow * data.health.savePct / 100) : 0;
        const movedNow = data.categories.expenses.filter(c => SAVINGS_RE.test(c)).reduce((s, c) => s + getNode('expenses', c, pos.yr, pos.m).actual, 0);
        // Money at each month's end, and net worth now.
        const trend = forwardTimeline.slice(0, nowIdx).filter(r => r.endProjectedBalance != null).slice(-11).map(r => ({ label: r.month, v: r.endProjectedBalance }));
        if (money != null) trend.push({ label: pos.m, v: money, now: true });
        const debts = (data.ious || []).filter(i => !i.settled && i.type === 'borrowed')
          .map(i => ({ ...i, left: Math.max(0, (parseFloat(i.amount) || 0) - repaidOf(i)), rate: typeof i.rate === 'number' ? i.rate : 0 }))
          .filter(i => i.left > 0.005).sort((a, b) => b.rate - a.rate || b.left - a.left);
        const owedToUs = (data.ious || []).filter(i => !i.settled && i.type !== 'borrowed').reduce((s, i) => s + Math.max(0, (parseFloat(i.amount) || 0) - repaidOf(i)), 0);
        const debtTotal = debts.reduce((s, i) => s + i.left, 0);
        // Where the money went in the last finished month: per group, plus debt paid back and what was left.
        const fp = past.length ? past[past.length - 1] : pos;
        const spentIn = (ok) => data.categories.expenses.filter(ok).reduce((s, c) => s + getNode('expenses', c, fp.yr, fp.m).actual, 0);
        const slices = data.groups.map(g => ({
          id: g.id, name: groupName(g), color: GROUP_HEX[g.color] || '#787774', oneoff: g.kind === 'oneoff', want: g.kind !== 'oneoff' && isWantGroup(g.id),
          v: spentIn(c => spendOk(c) && getMeta('expenses', c).bracket === g.id)
        })).filter(x => x.v > 0.005).sort((a, b) => b.v - a.v);
        const flowIn = sumIn(fp);
        const flowDebt = spentIn(c => loanItems.has(c) && !SAVINGS_RE.test(c));
        const flowSum = (pred) => slices.filter(pred).reduce((s, x) => s + x.v, 0);
        const flow = { pos: fp, income: flowIn, needs: flowSum(x => !x.oneoff && !x.want), wants: flowSum(x => x.want), once: flowSum(x => x.oneoff), debt: flowDebt };
        flow.left = flowIn - flow.needs - flow.wants - flow.once - flow.debt;
        return { slices, flow, core, money, hasAccounts, months, rates, wantRows, rising, yearly, subsYear, fees, incomeNow, setAside, movedNow, trend, debts, debtTotal, owedToUs,
          netWorth: money != null ? money - debtTotal + owedToUs : null };
      }, [data, forwardTimeline, nowIdx, accountsTotal, appNow]);

      // Wishlist: wait 72 hours before buying.
      const WISH_WAIT = 72 * 3600 * 1000;
      const [wishName, setWishName] = useState('');
      const [showAllYearly, setShowAllYearly] = useState(false);
      const [wishAmount, setWishAmount] = useState('');
      const addWish = () => {
        const amount = Math.round((parseFloat(String(wishAmount).replace(',', '.')) || 0) * 100) / 100;
        if (!wishName.trim()) return;
        mutate(d => { d.wishlist.push({ id: 'w' + Date.now().toString(36), name: wishName.trim(), amount, added: new Date().toISOString(), status: 'wait', decided: null }); });
        setWishName(''); setWishAmount('');
      };
      const decideWish = (id, status) => mutate(d => { const w = d.wishlist.find(x => x.id === id); if (w) { w.status = status; w.decided = new Date().toISOString(); } });
      const removeWish = (id) => mutate(d => { d.wishlist = d.wishlist.filter(x => x.id !== id); });
      // Work back from today's real total to the start of this month, using what's recorded so far.
      const useAccountsAsReal = () => {
        if (!nowRow) return;
        const start = round2(accountsTotal - nowRow.actualIn + nowRow.actualEx + futureNet);
        mutateWithUndo(d => { d.startingCapital = start; d.startingMonth = timelineKey(nowRow.year, nowRow.month); },
          t('accountsUsed', { amount: fmtCents(accountsTotal) }));
      };

      // ---- Category tidy-up: suggested groups for items that sit in a catch-all group ----
      const TIDY_RULES = [
        { gid: 'transport', kind: 'fixed', color: 'teal', re: /ticket|transport|mo\.?pla|deutschland/i },
        { gid: 'health', kind: 'fixed', color: 'pink', re: /\bgym\b|fitness|sport/i },
        { gid: 'education', kind: 'oneoff', color: 'purple', re: /\bb2\b|exam|prüfung|sprachkurs|\bkurs|\bfsp\b|ausbildung|schule|school/i },
        { gid: 'fees', kind: 'fixed', color: 'gray', re: /sparkasse|volksbank|gebühr|\bfees?\b/i },
        { gid: 'insurance', kind: 'fixed', color: 'brown', re: /versicherung|insurance|care concept|haftpflicht/i },
        { gid: 'family', kind: 'oneoff', color: 'orange', re: /sister|schwester|repayment|rückzahlung|darlehen/i }
      ];
      const tidyMoves = useMemo(() => {
        const out = [];
        data.categories.expenses.forEach(cat => {
          const cur = getMeta('expenses', cat).bracket;
          const rule = TIDY_RULES.find(r => r.re.test(cat));
          if (!rule || rule.gid === cur) return;
          // Receipt items (groceries, household …) stay with their monthly target.
          if (data.groups.find(g => g.id === cur)?.kind === 'variable') return;
          out.push({ cat, to: rule.gid, rule });
        });
        return out;
      }, [data]);
      const applyTidy = () => {
        const moves = tidyMoves;
        if (!moves.length) return;
        mutateWithUndo(d => {
          moves.forEach(({ rule }) => {
            if (d.groups.some(g => g.id === rule.gid)) return;
            const g = { id: rule.gid, kind: rule.kind, color: rule.color, name: null };
            const at = d.groups.findIndex(x => x.id === 'oneoff');
            if (at === -1) d.groups.push(g); else d.groups.splice(at, 0, g);
          });
          moves.forEach(({ cat, to }) => {
            const m = d.meta.expenses[cat];
            d.meta.expenses[cat] = metaForGroup(d.groups, to, m.payDay, m.once, m.forNext);
          });
        }, t('tidyDone', { n: moves.length }));
      };

      // ---- After the bills: what's left of a month once its fixed bills are paid ----
      const [abWhich, setAbWhich] = useState('next');
      const afterBills = useMemo(() => {
        if (nowIdx === -1) return null;
        const idx = abWhich === 'next' ? nowIdx + 1 : nowIdx;
        const row = forwardTimeline[idx];
        if (!row || row.startBal == null) return null;
        const { year: yr, month: m } = row;
        const days = getDaysInMonth(yr, m);
        const today = abWhich === 'next' ? 1 : new Date().getDate();
        const dayOf = (type, cat) => { const d = getMeta(type, cat).payDay; return Number.isInteger(d) ? Math.min(d, days) : null; };
        const isNow = abWhich !== 'next';
        // This month starts from the balance right now (everything received and spent so far, groceries included);
        // only what is still to come is added. Next month starts from this month's expected end.
        const entriesNow = row.startBal + row.actualIn - row.actualEx;
        // Your real account balances win when they were checked this month.
        const checked = data.accounts.map(x => x.updated).filter(Boolean).sort().pop() || null;
        const realNow = isNow && checked && checked.slice(0, 7) === todayISO().slice(0, 7) ? accountsTotal : null;
        const start = isNow ? (realNow ?? entriesNow) : row.startBal;
        // Income without a date (or overdue) counts at the month's end, bills without a date (or overdue) right away – both on the safe side.
        const incomes = data.categories.incomes.map(cat => {
          const n = getNode('incomes', cat, yr, m), d = dayOf('incomes', cat);
          const done = n.actual > 0;
          const day = done ? (d ?? 1) : d == null || d < today ? days : d;
          return { cat, v: expectedIncome(n), day, dated: d != null, done, counts: !(isNow && done) };
        }).filter(x => x.v > 0);
        const bills = data.categories.expenses.filter(cat => !isReceiptItem(cat)).map(cat => {
          const n = getNode('expenses', cat, yr, m), d = dayOf('expenses', cat);
          const done = n.actual > 0;
          const day = done ? (d ?? 1) : Math.max(d ?? today, today);
          return { cat, v: knownAmount(n), day, dated: d != null, done, counts: !(isNow && done) };
        }).filter(x => x.v > 0).sort((p1, p2) => p1.day - p2.day);
        // Day-by-day balance before any further day-to-day (variable) spending.
        const bal = [];
        let run = start;
        for (let d = 1; d <= days; d++) {
          if (d >= today) {
            incomes.forEach(x => { if (x.counts && x.day === d) run += x.v; });
            bills.forEach(x => { if (x.counts && x.day === d) run -= x.v; });
          }
          bal.push(run);
        }
        // The main payday: the biggest income still to come after the first days (small extras don't end the stretch).
        const fromDay = Math.max(today, 5 > days ? days : 5);
        const later = incomes.filter(x => x.day > fromDay);
        const nextIn = later.length ? later.reduce((best, x) => x.v > best.v ? x : best) : null;
        const untilDay = nextIn ? nextIn.day : days;
        // Lowest point between now and that payday: what can be spent before the big money arrives.
        let lowDay = today;
        for (let d = today; d <= Math.max(today, nextIn ? untilDay - 1 : days); d++) if (bal[d - 1] <= bal[lowDay - 1]) lowDay = d;
        const incomeAfter = incomes.filter(x => x.counts && x.day >= untilDay && nextIn);
        const spendable = bal[lowDay - 1];
        const spanDays = Math.max(1, untilDay - fromDay);
        const sum = (list) => list.reduce((s2, x) => s2 + x.v, 0);
        const billsAll = sum(bills);
        // Day-to-day spending still expected this month (target, or more if already over it).
        const variable = isNow ? Math.max(0, row.projectedEx - row.actualEx - sum(bills.filter(x => !x.done)))
          : Math.max(0, row.projectedEx - billsAll);
        const variableSpan = variable * spanDays / Math.max(1, days - today + 1);
        return { yr, m, days, today, isNow, start, realNow, entriesNow, checked, incomes, bills, bal, lowDay, spendable, nextIn, untilDay, fromDay, spanDays,
          perDay: spendable / spanDays, onDay5: bal[Math.min(5, days) - 1], inLate: sum(incomeAfter), end: bal[days - 1],
          variable, variableSpan, afterVariable: row.endProjectedBalance,
          undatedBills: bills.filter(x => !x.dated).length, undatedIn: incomes.filter(x => !x.dated && !x.done).length };
      }, [forwardTimeline, nowIdx, abWhich, data, accountsTotal]);
      const [abList, setAbList] = useState(false);
      const renderAfterBills = () => {
        const a = afterBills;
        if (!a) return null;
        const mon = formatMonth(a.m, lang);
        const tone = (v) => v < 0 ? 'text-notion-red' : 'text-primary';
        const row = (label, v, sign, cls) => (
          <div className="flex items-center justify-between gap-3 text-[12px]">
            <span className="text-secondary">{label}</span>
            <span className={`font-mono ${cls || 'text-primary'}`}>{sign}{fmt(v)}</span>
          </div>
        );
        // Small step chart of the month: bills pull it down, income lifts it.
        const W = 300, H = 70, lo = Math.min(0, ...a.bal), hi = Math.max(1, ...a.bal, a.start);
        const X = (d) => 4 + (d - 1) / Math.max(1, a.days - 1) * (W - 8);
        const Y = (v) => 6 + (hi - v) / (hi - lo || 1) * (H - 12);
        const first = a.today - 1;
        const path = a.bal.map((v, i) => i < first ? '' : `${i === first ? 'M' : 'L'} ${X(i + 1)} ${Y(i === first ? a.start : a.bal[i - 1])} L ${X(i + 1)} ${Y(v)}`).join(' ');
        const fits = a.spendable >= a.variableSpan;
        return panel({ id: 'afterBills', icon: 'fa-file-invoice-dollar', title: t('abTitle'), sub: `${mon} ${a.yr}`,
          right: <Segmented size="sm" options={[['now', t('abThis')], ['next', t('abNext')]]} value={abWhich} onChange={setAbWhich} /> }, (
          <div className="space-y-3">
            <div className="rounded-xl bg-subtle/70 px-3.5 py-3">
              <div className="text-[11px] text-secondary">{a.nextIn ? t('abSpendUntil', { day: a.untilDay, month: mon }) : t('abSpendMonth')}</div>
              <div className={`mt-0.5 text-[26px] leading-tight font-semibold font-mono ${a.spendable < 0 ? 'text-notion-red' : 'text-notion-green'}`}>{fmt(a.spendable)}</div>
              <div className="text-[11px] text-secondary mt-1">
                {a.spendable > 0 ? t('abPerDay', { amount: fmt(a.perDay), n: a.spanDays, from: a.fromDay, to: a.untilDay }) : t('abNothing')}
              </div>
            </div>
            <svg viewBox={`0 0 ${W} ${H + 12}`} className="w-full h-auto" role="img" aria-label={t('abTitle')}>
              <line x1="0" x2={W} y1={Y(0)} y2={Y(0)} stroke="currentColor" className="text-tertiary" strokeWidth="0.7" strokeDasharray="3 3" />
              <rect x={X(a.fromDay)} y="0" width={Math.max(0, X(a.untilDay) - X(a.fromDay))} height={H} fill="#10b981" opacity="0.08" />
              <path d={path} fill="none" stroke="#3b82f6" strokeWidth="1.8" strokeLinejoin="round" />
              <circle cx={X(a.lowDay)} cy={Y(a.spendable)} r="3.5" fill={a.spendable < 0 ? '#ef4444' : '#f59e0b'} />
              {a.nextIn && <circle cx={X(a.untilDay)} cy={Y(a.bal[a.untilDay - 1])} r="3" fill="#10b981" />}
              {[1, 5, 10, 15, 20, 25, a.days].map(d => (
                <text key={d} x={X(d)} y={H + 10} textAnchor={d === 1 ? 'start' : d === a.days ? 'end' : 'middle'} fontSize="8.5" fill="currentColor" className="text-tertiary">{d}.</text>
              ))}
            </svg>
            <div className="space-y-1.5 rounded-xl border border-subtle p-3">
              {row(a.realNow != null ? t('abRealBal', { date: a.checked.slice(8, 10) + '.' + a.checked.slice(5, 7) + '.' }) : t(a.isNow ? 'abNowBal' : 'abStart'), a.start, '', tone(a.start))}
              {a.realNow != null && Math.abs(a.realNow - a.entriesNow) >= 1 && (
                <div className="text-[11px] text-tertiary">{t('abRealDiff', { amount: fmt(a.entriesNow) })}</div>
              )}
              {a.isNow && a.realNow == null && (
                <div className="text-[11px] text-tertiary">{t('abNoReal')}</div>
              )}
              {a.today <= 5 && row(t('abOnDay', { day: Math.min(5, a.days), month: mon }), a.onDay5, '', tone(a.onDay5))}
              {row(t('abLowest', { day: a.lowDay, month: mon }), a.spendable, '', `font-semibold ${tone(a.spendable)}`)}
              {a.inLate > 0 && row(t('abLateIn', { day: a.untilDay }), a.inLate, '+ ', 'text-notion-green')}
              <div className="border-t border-subtle pt-1.5">{row(t('abEnd', { month: mon }), a.end, '', `font-semibold ${tone(a.end)}`)}</div>
            </div>
            {a.variable > 0 && (
              <p className={`text-[11px] ${fits ? 'text-secondary' : 'text-notion-red'}`}>
                {t(a.isNow ? (fits ? 'abFitsNow' : 'abTightNow') : (fits ? 'abFits' : 'abTight'), { amount: fmt(a.variableSpan), from: a.fromDay, to: a.untilDay, month: fmt(a.variable) })}
              </p>
            )}
            <button onClick={() => setAbList(v => !v)} className="text-[12px] text-notion-blue hover:underline">
              <i className={`fa-solid fa-chevron-down text-[9px] me-1.5 transition-transform ${abList ? 'rotate-180' : ''}`}></i>
              {abList ? t('abHideList') : t('abShowList2', { n: a.bills.length + a.incomes.length })}
            </button>
            {abList && (
              <div className="space-y-1">
                {[...a.incomes.map(x => ({ ...x, inc: true })), ...a.bills].sort((p1, p2) => p1.day - p2.day || (p2.inc ? 1 : 0) - (p1.inc ? 1 : 0)).map(x => (
                  <div key={(x.inc ? 'i' : 'b') + x.cat} className="flex items-center gap-2 text-[12px]">
                    <span className={`w-9 shrink-0 text-[11px] font-mono ${x.dated ? 'text-secondary' : 'text-tertiary'}`}>{x.dated ? `${x.day}.` : '–'}</span>
                    <span className="flex-1 truncate text-primary">{x.cat}</span>
                    {x.done && <i className="fa-solid fa-check text-[10px] text-notion-green"></i>}
                    <span className={`font-mono ${x.inc ? 'text-notion-green' : 'text-secondary'}`}>{x.inc ? '+ ' : '− '}{fmt(x.v)}</span>
                  </div>
                ))}
                {(a.undatedBills > 0 || a.undatedIn > 0) && <p className="text-[11px] text-tertiary pt-1">{t('abUndated2', { b: a.undatedBills, i: a.undatedIn })}</p>}
              </div>
            )}
            <div className="text-[11px]"><Hint label={t('howCalc')} text={t('abHint2')} /></div>
          </div>
        ));
      };

      const renderForecast = () => (
        <>
                        {forecastShown.length > 1 && (() => {
                          const rows = forecastShown;
                          const vals = rows.map(r => r.endProjectedBalance);
                          const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
                          const range = hi - lo || 1;
                          const H = 90, W = 300, pad = 4, bw = (W - pad * 2) / rows.length;
                          const y = (v) => pad + (hi - v) / range * (H - pad * 2);
                          const low = forecast.length ? forecast.reduce((a, b) => b.endProjectedBalance < a.endProjectedBalance ? b : a) : rows[0];
                          const labelSize = rows.length > 14 ? 7 : rows.length > 8 ? 8.5 : 10;
                          const nowKey = forecast[0]?.key;
                          // Where a regular income stops, mark the first month without it.
                          const endMarks = incomeEndings.groups
                            .map(g => ({ ...g, i: rows.findIndex(r => r.year === g.from.yr && r.month === g.from.m) }))
                            .filter(g => g.i > 0);
                          return (
                            <div className={`rounded-2xl border border-subtle bg-surface p-4 space-y-2`}>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[13px] font-semibold text-primary">{t(forecastRange === 'all' ? 'forecastTitleAll' : 'forecastTitle')}</span>
                                <Segmented size="sm" options={[['next', t('forecastNext')], ['all', t('forecastAll')]]} value={forecastRange} onChange={setForecastRange} />
                              </div>
                              <svg viewBox={`0 0 ${W} ${H + 16}`} className="w-full h-auto" role="img" aria-label={t('forecastTitle')}>
                                <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="currentColor" className="text-tertiary" strokeWidth="1" strokeDasharray="3 3" />
                                {rows.map((r, i) => {
                                  const v = r.endProjectedBalance;
                                  const isPastBar = monthStatus(r.year, r.month) === 'past';
                                  const top = Math.min(y(v), y(0)), h = Math.max(1.5, Math.abs(y(v) - y(0)));
                                  return (
                                    <g key={r.key}>
                                      <rect x={pad + i * bw + bw * 0.18} y={top} width={bw * 0.64} height={h} rx="3"
                                        fill={v < 0 ? '#e03e3e' : r === low ? '#cb912f' : isPastBar ? '#64748b' : '#0f7b6c'} opacity={r === low || r.key === nowKey ? 1 : 0.75} />
                                      {r.key === nowKey && forecastRange === 'all' && <rect x={pad + i * bw + bw * 0.1} y={1} width={bw * 0.8} height={H - 2} rx="4" fill="none" stroke="currentColor" className="text-tertiary" strokeWidth="0.8" strokeDasharray="2 2" />}
                                      <text x={pad + i * bw + bw / 2} y={H + 13} textAnchor="middle" fontSize={labelSize} fill="currentColor" className="text-tertiary">
                                        {lang === 'ar' ? ALL_MONTHS.indexOf(r.month) + 1 : (rows.length > 14 ? formatMonth(r.month, lang).slice(0, 1) : formatMonth(r.month, lang))}
                                      </text>
                                    </g>
                                  );
                                })}
                                {endMarks.map(g => (
                                  <g key={g.fromIdx}>
                                    <line x1={pad + g.i * bw} x2={pad + g.i * bw} y1="0" y2={H} stroke="#e03e3e" strokeWidth="1.5" strokeDasharray="2 2" />
                                  </g>
                                ))}
                              </svg>
                              <p className={`text-[11px] ${low.endProjectedBalance < 0 ? 'text-notion-red font-medium' : 'text-secondary'}`}>
                                {t(low.endProjectedBalance < 0 ? 'forecastNegative' : 'forecastLow', { amount: fmt(low.endProjectedBalance), month: monthLabel(low.year, low.month) })}
                              </p>
                            </div>
                          );
                        })()}
        </>
      );

      // ---- Numbers for the selected month (not used on the plan page) ----
      const MB = (() => {
        if (isAnnual) return null;
        const cm = currentMetrics;
        if (!cm || !cm.fixed) return null;
        const prev = prevMonthOf(selectedYear, selectedMonth);
        const isPast = monthStatus(selectedYear, selectedMonth) === 'past';
        const beforeStart = cm.endProjectedBalance == null;
        const carriedLabel = cm.isAnchor || !prev ? t('carriedStart') : t('carriedOver', { month: monthLabel(prev.yr, prev.m) });
        const flexLeft = cm.flex.plan - cm.flex.spent;
        const lines = [
          { label: carriedLabel, text: fmtBalance(cm.startBal), cls: cm.startBal < 0 ? 'text-notion-red' : 'text-primary' },
          { label: t('lineIncome'), text: `+ ${fmt(cm.projectedIn)}`, cls: 'text-notion-green' },
          { label: t('lineFixed'), text: `− ${fmt(cm.fixed.expected)}`, cls: 'text-notion-red' },
          { label: t('lineFlex'), text: `− ${fmt(cm.flex.expected)}`, cls: 'text-notion-red' }
        ];
        // What should be in the accounts right now, according to what's recorded so far.
        const availableNow = !beforeStart && monthStatus(selectedYear, selectedMonth) === 'current'
          ? cm.startBal + cm.actualIn - cm.actualEx - futureNet : null;
        const incomeHasAmount = (cat) => { const n = getNode('incomes', cat, selectedYear, selectedMonth); return n.budget > 0 || n.actual > 0; };
        const visibleIncomes = data.categories.incomes.filter(cat => incomeHasAmount(cat) || (showEmpty.__incomes && !getMeta('incomes', cat).oneTime));
        const hiddenIncomes = data.categories.incomes.filter(cat => !incomeHasAmount(cat) && !getMeta('incomes', cat).oneTime).length;
        const filtered = groupView.filter(gv => expFilter === 'all' || (expFilter === 'fixed' ? gv.g.kind === 'fixed' : gv.g.kind !== 'fixed'));
        const isActive = (gv) => gv.items.some(i => i.node.budget > 0 || i.node.actual > 0) || (gv.g.kind === 'variable' && gv.target > 0);
        const activeGroups = filtered.filter(isActive);
        // One-time groups with nothing this month don't belong to the month at all.
        const emptyGroups = filtered.filter(gv => !isActive(gv) && gv.g.kind !== 'oneoff');
        const meters = [
          { label: t('lineIncome'), done: cm.actualIn, total: cm.projectedIn, color: '#10b981',
            sub: cm.projectedIn > cm.actualIn ? t('stillExpected', { amount: fmt(cm.projectedIn - cm.actualIn) }) : t('receivedOf', { done: fmt(cm.actualIn), total: fmt(cm.projectedIn) }) },
          { label: t('lineFixed'), done: cm.fixed.paid, total: cm.fixed.expected, color: '#3b82f6',
            sub: t('paidCount', { n: cm.fixed.paidItems, m: cm.fixed.items }) + (cm.fixed.expected > cm.fixed.paid ? ` · ${t('stillOpen', { amount: fmt(cm.fixed.expected - cm.fixed.paid) })}` : '') },
          { label: t('lineFlex'), done: cm.flex.spent, total: cm.flex.plan, color: flexLeft < 0 ? '#ef4444' : '#f59e0b', over: flexLeft < 0,
            sub: flexLeft < 0 ? t('targetOver', { amount: fmt(-flexLeft) }) : t('targetLeft', { amount: fmt(flexLeft) }) }
        ];
        return { cm, isPast, beforeStart, carriedLabel, lines, availableNow, visibleIncomes, hiddenIncomes, activeGroups, emptyGroups, meters };
      })();

      const NAV = [
        ['overview', 'fa-house', t('navOverview')],
        ['month', 'fa-layer-group', t('navMonth')],
        ['book', 'fa-plus', t('navBook')],
        ['activity', 'fa-receipt', t('navActivity')],
        ['plan', 'fa-chart-line', t('navPlan')],
        ['health', 'fa-heart-pulse', t('healthTitle')],
        ['more', 'fa-grip', t('navMore')]
      ];
      const viewTitle = (NAV.find(n => n[0] === view) || NAV[0])[2];
      // Large title area (phones): the small title in the bar appears once the big one has scrolled away.
      const [scrolled, setScrolled] = useState(false);
      useEffect(() => {
        const on = () => setScrolled(window.scrollY > 72);
        on(); window.addEventListener('scroll', on, { passive: true });
        return () => window.removeEventListener('scroll', on);
      }, []);
      const heroSub = (() => {
        if (view === 'overview' || view === 'month' || view === 'book' || view === 'activity') return `${formatMonth(selectedMonth, lang)} ${selectedYear} · ${data.name || t('title')}`;
        if (view === 'plan') return `${selectedYear} · ${data.name || t('title')}`;
        return data.name || t('title');
      })();
      const showMonthNav = view === 'overview' || view === 'month' || view === 'activity' || view === 'book';
      const syncColor = syncStatus === 'error' ? 'text-notion-red' : user ? 'text-notion-green' : 'text-tertiary';
      const nowPos = TIMELINE[nowIdx];

      const monthNav = (
        <div className="relative flex items-center gap-0.5">
          <button onClick={() => goMonth(TIMELINE[curIdx - 1])} disabled={curIdx <= 0} aria-label={t('prevMonth')}
            className="w-8 h-8 rounded-full text-secondary hover:text-primary hover:bg-subtle disabled:opacity-30">
            <i className="fa-solid fa-chevron-left text-[11px] rtl:rotate-180"></i>
          </button>
          <button onClick={() => setMonthPicker(v => !v)} aria-expanded={monthPicker}
            className="h-8 px-3 rounded-full bg-subtle text-[13px] font-semibold text-primary flex items-center gap-1.5 whitespace-nowrap">
            {formatMonth(selectedMonth, lang)} {selectedYear}
            {monthStatus(selectedYear, selectedMonth) === 'current' && <span className="w-1.5 h-1.5 rounded-full bg-notion-blue"></span>}
          </button>
          <button onClick={() => goMonth(TIMELINE[curIdx + 1])} disabled={curIdx >= TIMELINE.length - 1} aria-label={t('nextMonth')}
            className="w-8 h-8 rounded-full text-secondary hover:text-primary hover:bg-subtle disabled:opacity-30">
            <i className="fa-solid fa-chevron-right text-[11px] rtl:rotate-180"></i>
          </button>
          {monthPicker && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMonthPicker(false)}></div>
              <div className="pop-in absolute end-0 top-10 z-50 w-[292px] rounded-2xl border border-subtle bg-surface shadow-2xl p-3 space-y-3">
                {YEARS.map(yr => (
                  <div key={yr}>
                    <div className="text-[11px] font-semibold text-secondary mb-1.5">{yr}</div>
                    <div className={`grid ${lang === 'ar' ? 'grid-cols-4' : 'grid-cols-6'} gap-1`}>
                      {ALL_MONTHS.map(m => {
                        const ok = getMonthsForYear(yr).includes(m);
                        const sel = yr === selectedYear && m === selectedMonth;
                        const cur = nowPos && nowPos.yr === yr && nowPos.m === m;
                        return (
                          <button key={m} disabled={!ok} onClick={() => goMonth({ yr, m })}
                            className={`h-8 rounded-lg text-[11px] disabled:opacity-25 ${sel ? 'bg-primary text-surface font-semibold' : cur ? 'text-notion-blue font-semibold hover:bg-subtle' : 'text-primary hover:bg-subtle'}`}>
                            {formatMonth(m, lang)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {nowPos && <button onClick={() => goMonth(nowPos)} className="w-full h-8 rounded-lg bg-subtle text-xs font-medium text-primary">{t('todayBtn')}</button>}
              </div>
            </>
          )}
        </div>
      );

      // ---- Cards shared by several pages ----
      const renderDue = () => {
        if (!dueSoon.length) return null;
        const offs = dueScope === 'this' ? [0] : dueScope === 'next' ? [1] : [0, 1];
        const sections = offs.map(off => {
          const p = TIMELINE[nowIdx + off];
          const items = dueSoon.filter(x => x.off === off);
          return { off, p, items, total: items.reduce((sum, x) => sum + x.amount, 0) };
        }).filter(sec => sec.p);
        const perSection = dueExpanded ? Infinity : (sections.length > 1 ? 4 : 6);
        const hiddenCount = sections.reduce((n, sec) => n + Math.max(0, sec.items.length - perSection), 0);
        const openTotal = sections.reduce((sum, sec) => sum + sec.total, 0);
        return panel({
          id: 'due', icon: 'fa-calendar-check', title: t('dueTitle'), sub: openTotal ? fmt(openTotal) : null,
          toolbar: <Segmented full size="sm" options={[['this', t('dueThis')], ['next', t('dueNext')], ['both', t('dueBoth')]]} value={dueScope} onChange={(v) => { setDueScope(v); setDueExpanded(false); }} />
        }, (
          <div className="space-y-3">
            {sections.map(sec => (
              <div key={sec.off} className="space-y-1">
                {sections.length > 1 && (
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-secondary">{formatMonth(sec.p.m, lang)} {sec.p.yr}</span>
                    <span className="font-mono text-secondary">{sec.items.length ? fmt(sec.total) : ''}</span>
                  </div>
                )}
                {sec.items.length === 0 && <p className="text-[11px] text-tertiary">{t('dueNothing')}</p>}
                {sec.items.slice(0, perSection).map(x => (
                  <div key={`${x.cat}|${x.m}|${x.yr}`} className="grid grid-cols-[24px_28px_minmax(0,1fr)_auto] items-center gap-2.5 py-1">
                    <button onClick={() => updateNode('expenses', x.cat, x.yr, x.m, 'actual', x.amount)} aria-label={t('markPaidAria', { name: x.cat })}
                      className="w-6 h-6 rounded-full border-[1.5px] border-strong text-transparent hover:border-notion-green hover:text-notion-green text-[10px] leading-none">✓</button>
                    <ItemIcon spec={iconFor('expenses', x.cat)} tint={tintFor('expenses', x.cat)} size={28} />
                    <div className="min-w-0">
                      <div className="text-[13px] text-primary truncate">{x.cat}</div>
                      <div className={`text-[11px] ${x.overdue ? 'text-notion-red font-medium' : 'text-tertiary'}`}>
                        {x.overdue ? t('dueOverdue', { day: x.day, month: formatMonth(x.m, lang) }) : x.day ? t('dueOnDay', { day: x.day, month: formatMonth(x.m, lang) }) : t('dueNoDay')}
                      </div>
                    </div>
                    <span className="font-mono text-[13px] text-primary">{fmtCents(x.amount)}</span>
                  </div>
                ))}
              </div>
            ))}
            {hiddenCount > 0 && (
              <button onClick={() => setDueExpanded(v => !v)} aria-expanded={dueExpanded} className="text-[12px] text-notion-blue hover:underline">
                {dueExpanded ? t('dueLess') : t('dueMore', { n: hiddenCount })}
              </button>
            )}
          </div>
        ));
      };

      const renderIncomeEnd = (dismissible) => {
        if (!incomeEndings.rows.length) return null;
        const first = incomeEndings.groups[0];
        const total = incomeEndings.rows.reduce((sum, r) => sum + r.amount, 0);
        return panel({
          id: 'incomeEnd', tone: 'warn', icon: 'fa-triangle-exclamation', title: t('incomeEndTitle'), defaultCollapsed: true, dismissible,
          sub: t('incomeEndShort', { n: incomeEndings.rows.length, month: first ? `${formatMonth(first.from.m, lang)} ${first.from.yr}` : '', amount: fmt(total) })
        }, (
          <div className="space-y-2">
            {incomeEndings.rows.map(r => (
              <div key={r.cat} className="text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-primary truncate">{r.cat}</span>
                  <span className="font-mono text-notion-red shrink-0">−{fmt(r.amount)}</span>
                </div>
                <div className="text-[11px] text-tertiary">
                  {t('incomeEndLast', { when: r.payDay ? `${r.payDay}. ${formatMonth(r.last.m, lang)} ${r.last.yr}` : `${formatMonth(r.last.m, lang)} ${r.last.yr}` })}
                  {' · '}{t('incomeEndFrom', { month: `${formatMonth(r.from.m, lang)} ${r.from.yr}` })}
                </div>
              </div>
            ))}
            <Hint label={t('showDetails')} text={t('incomeEndHint')} />
          </div>
        ));
      };

      // ---- Pages ----
      const pct = (x) => x == null ? '–' : `${Math.round(x * 100)} %`;
      // Each topic is its own card, so the page can spread over two columns on wide screens.
      const renderHealth = (only) => {
        const h = health;
        if (!h) return null;
        const sec = (icon, title, hint, body) => only && !only.includes(icon) ? null : panel({ id: 'health_' + icon, icon, title }, (
          <div className="space-y-2">
            {body}
            {hint && <div className="text-[11px] pt-1"><Hint label={t('healthWhy')} text={hint} /></div>}
          </div>
        ));
        const bar = (v, max, color) => (
          <div className="h-2 rounded-full bg-subtle overflow-hidden"><div className="h-full rounded-full transition-all" style={{ width: `${max > 0 ? Math.max(0, Math.min(100, v / max * 100)) : 0}%`, background: color }}></div></div>
        );
        const monthsTone = h.months == null ? 'text-tertiary' : h.months >= 6 ? 'text-notion-green' : h.months >= 3 ? 'text-primary' : 'text-notion-red';
        const target = data.health.savePct / 100;
        const rateMax = Math.max(0.3, target, ...h.rates.map(r => Math.abs(r.rate || 0)));
        const w = h.wantRows[h.wantRows.length - 1];
        const tmin = Math.min(...h.trend.map(x => x.v), 0), tmax = Math.max(...h.trend.map(x => x.v), 1);
        const W = 300, H = 64, X = (i) => h.trend.length > 1 ? 6 + i * (W - 12) / (h.trend.length - 1) : W / 2, Y = (v) => H - 6 - (v - tmin) / (tmax - tmin || 1) * (H - 12);
        const groupsForToggle = data.groups.filter(g => g.kind !== 'oneoff');
        // Half-circle gauge from 0 to 6 months.
        const arc = (cx, cy, r, a0, a1) => {
          const pt = (a) => [cx + r * Math.cos(Math.PI * (1 - a)), cy - r * Math.sin(Math.PI * (1 - a))];
          const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
          return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
        };
        const gaugeV = Math.max(0, Math.min(6, h.months || 0)) / 6;
        const needle = [100 + 62 * Math.cos(Math.PI * (1 - gaugeV)), 96 - 62 * Math.sin(Math.PI * (1 - gaugeV))];
        const fmtShort = (v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1).replace('.', lang === 'en' ? '.' : ',')}k` : String(Math.round(v));
        return (
          <>
            {sec('fa-umbrella', t('efTitle'), t('efHint'), (
              <div className="space-y-2">
                <div className="flex justify-center">
                  <svg viewBox="0 0 200 112" className="w-full h-auto" style={{ maxWidth: 260 }} role="img" aria-label={t('efTitle')}>
                    <defs>
                      <linearGradient id="efGrad" x1="0" x2="1" y1="0" y2="0">
                        <stop offset="0" stopColor="#ef4444" /><stop offset="0.45" stopColor="#f59e0b" /><stop offset="1" stopColor="#10b981" />
                      </linearGradient>
                    </defs>
                    <path d={arc(100, 96, 72, 0, 1)} fill="none" stroke="currentColor" className="text-subtle" strokeOpacity="0.5" strokeWidth="14" strokeLinecap="round" />
                    {gaugeV > 0.005 && <path d={arc(100, 96, 72, 0, gaugeV)} fill="none" stroke="url(#efGrad)" strokeWidth="14" strokeLinecap="round" />}
                    {[0.5, 1].map(a => { const [x, y] = [100 + 86 * Math.cos(Math.PI * (1 - a)), 96 - 86 * Math.sin(Math.PI * (1 - a))]; return <text key={a} x={x} y={y + 3} textAnchor="middle" fontSize="9" fill="currentColor" className="text-tertiary">{a * 6}</text>; })}
                    <text x={100 - 86} y={99} textAnchor="middle" fontSize="9" fill="currentColor" className="text-tertiary">0</text>
                    <line x1="100" y1="96" x2={needle[0]} y2={needle[1]} stroke="currentColor" className="text-primary" strokeWidth="2.5" strokeLinecap="round" />
                    <circle cx="100" cy="96" r="5" fill="currentColor" className="text-primary" />
                    <text x="100" y="76" textAnchor="middle" fontSize="20" fontWeight="700" fill="currentColor" className={monthsTone}>{h.months == null ? '–' : h.months.toFixed(1).replace('.', lang === 'en' ? '.' : ',')}</text>
                  </svg>
                </div>
                <div className="flex items-baseline justify-between gap-2 -mt-1">
                  <span className={`text-[13px] font-semibold ${monthsTone}`}>{h.months == null ? '–' : t('efMonths', { n: h.months.toFixed(1).replace('.', lang === 'en' ? '.' : ',') })}</span>
                  <span className="text-[11px] text-secondary text-end">{t('efCore', { amount: fmt(h.core) })}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  {[[t('efHave'), h.money], [t('ef3'), h.core * 3], [t('ef6'), h.core * 6]].map(([l, v]) => (
                    <div key={l} className="rounded-lg bg-subtle/70 px-2 py-1.5 min-w-0"><div className="text-tertiary truncate">{l}</div><div className="font-mono text-primary truncate">{v == null ? '–' : fmt(v)}</div></div>
                  ))}
                </div>
                {!h.hasAccounts && <p className="text-[11px] text-tertiary">{t('efNoAccounts')}</p>}
              </div>
            ))}

            {sec('fa-piggy-bank', t('srTitle'), t('srHint'), (
              <div className="space-y-2">
                <div className="flex items-end gap-1.5 h-20">
                  {h.rates.map(r => {
                    const v = r.rate == null ? 0 : r.rate;
                    return (
                      <div key={`${r.yr}|${r.m}`} className="flex-1 min-w-0 flex flex-col items-center gap-1 h-full justify-end">
                        <span className={`text-[10px] font-mono ${r.rate == null ? 'text-tertiary' : v < 0 ? 'text-notion-red' : v >= target && target > 0 ? 'text-notion-green' : 'text-primary'}`}>{pct(r.rate)}</span>
                        <div className={`w-full rounded-t ${r.now ? 'opacity-60' : ''}`} style={{ height: `${Math.max(2, Math.abs(v) / rateMax * 44)}px`, background: v < 0 ? '#ef4444' : '#3b82f6' }}></div>
                        <span className="text-[10px] text-tertiary truncate">{formatMonth(r.m, lang)}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] text-secondary">{t('srRule')}</span>
                  <Segmented size="sm" options={[[0, t('srOff')], [10, '10 %'], [15, '15 %'], [20, '20 %'], [25, '25 %']]} value={data.health.savePct}
                    onChange={(v) => mutate(d => { d.health.savePct = v; })} />
                </div>
                {data.health.savePct > 0 && (
                  <div className="rounded-xl bg-subtle/60 px-3 py-2 text-[12px] text-primary">
                    {t('srPayday', { amount: fmt(h.setAside), pct: data.health.savePct, income: fmt(h.incomeNow) })}
                    <div className="mt-1.5">{bar(h.movedNow, h.setAside, '#10b981')}</div>
                    <div className="mt-1 text-[11px] text-secondary">{h.movedNow >= h.setAside - 0.005 ? t('srDone') : t('srSoFar', { amount: fmt(h.movedNow) })}</div>
                  </div>
                )}
              </div>
            ))}

            {sec('fa-scale-balanced', t('nwTitle'), t('nwHint'), (
              <div className="space-y-2">
                <div className="flex items-baseline justify-between text-[12px]">
                  <span className="text-secondary">{t('nwShare', { month: formatMonth(w.m, lang) })}</span>
                  <span className={`font-mono font-semibold ${w.share > 0.3 ? 'text-notion-red' : 'text-primary'}`}>{pct(w.share)}</span>
                </div>
                {bar(w.wants, w.total, '#ec4899')}
                <div className="flex gap-3 text-[11px] text-tertiary">
                  {h.wantRows.slice(0, -1).map(r => <span key={`${r.yr}|${r.m}`}>{formatMonth(r.m, lang)} {pct(r.share)}</span>)}
                </div>
                {h.rising && <p className="text-[11px] text-notion-red">{t('nwRising')}</p>}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {groupsForToggle.map(g => {
                    const want = isWantGroup(g.id);
                    return (
                      <button key={g.id} type="button" onClick={() => mutate(d => { d.health.wants[g.id] = !want; })}
                        className={`px-2.5 py-1 rounded-full text-[11px] border ${want ? 'border-pink-500/40 bg-pink-500/10 text-pink-600 dark:text-pink-300' : 'border-subtle bg-subtle text-secondary'}`}>
                        {groupName(g)} · {want ? t('nwWant') : t('nwNeed')}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {sec('fa-chart-pie', t('wgTitle', { month: `${formatMonth(h.flow.pos.m, lang)} ${h.flow.pos.yr}` }), t('wgHint'), h.slices.length === 0 ? <p className="text-[12px] text-tertiary">{t('wgNone')}</p> : (() => {
              const total = h.slices.reduce((s, x) => s + x.v, 0);
              const R = 42, C = 2 * Math.PI * R;
              let acc = 0;
              const f = h.flow;
              const flowParts = [
                ['needs', f.needs, '#3b82f6'], ['wants', f.wants, '#ec4899'], ['once', f.once, '#94a3b8'], ['debt', f.debt, '#f59e0b'],
                ['left', Math.max(0, f.left), '#10b981']
              ].filter(x => x[1] > 0.005);
              const flowTotal = Math.max(f.income, flowParts.reduce((s, x) => s + x[1], 0)) || 1;
              return (
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <svg viewBox="0 0 120 120" className="shrink-0" style={{ width: 128, height: 128 }} role="img" aria-label={t('wgTitle', { month: '' })}>
                      <g transform="rotate(-90 60 60)">
                      <circle cx="60" cy="60" r={R} fill="none" stroke="currentColor" className="text-subtle" strokeWidth="16" />
                      {h.slices.map(x => {
                        const len = x.v / total * C;
                        const el = <circle key={x.id} cx="60" cy="60" r={R} fill="none" stroke={x.color} strokeWidth="16" strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`} strokeDashoffset={-acc} />;
                        acc += len;
                        return el;
                      })}
                      </g>
                      <g>
                        <text x="60" y="57" textAnchor="middle" fontSize="15" fontWeight="700" fill="currentColor" className="text-primary">{fmtShort(total)} €</text>
                        <text x="60" y="72" textAnchor="middle" fontSize="8.5" fill="currentColor" className="text-tertiary">{t('wgSpent')}</text>
                      </g>
                    </svg>
                    <div className="flex-1 min-w-0 space-y-1.5">
                      {h.slices.slice(0, 7).map(x => (
                        <div key={x.id} className="flex items-center gap-2 text-[12px]">
                          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: x.color }}></span>
                          <span className="flex-1 truncate text-primary">{x.name}</span>
                          <span className="text-tertiary font-mono text-[11px]">{Math.round(x.v / total * 100)}%</span>
                          <span className="font-mono text-secondary w-16 text-end">{fmt(x.v)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {f.income > 0 && (
                    <div className="space-y-1.5">
                      <div className="flex items-baseline justify-between text-[12px]">
                        <span className="text-secondary">{t('wgFlow')}</span>
                        <span className="font-mono text-primary">{fmt(f.income)}</span>
                      </div>
                      <div className="flex rounded-lg overflow-hidden" style={{ height: 28 }}>
                        {flowParts.map(([k, v, color]) => (
                          <div key={k} title={`${t('wg_' + k)} ${fmt(v)}`} className="h-full flex items-center justify-center text-[10px] font-semibold text-white overflow-hidden transition-all"
                            style={{ width: `${v / flowTotal * 100}%`, background: color }}>{v / flowTotal > 0.09 ? `${Math.round(v / (f.income || 1) * 100)}%` : ''}</div>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                        {flowParts.map(([k, v, color]) => (
                          <span key={k} className="flex items-center gap-1.5 text-secondary"><span className="w-2 h-2 rounded-full" style={{ background: color }}></span>{t('wg_' + k)} <span className="font-mono text-primary">{fmt(v)}</span></span>
                        ))}
                        {f.left < -0.005 && <span className="text-notion-red">{t('wgShort', { amount: fmt(-f.left) })}</span>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })())}

            {sec('fa-calendar-days', t('ycTitle'), t('ycHint'), (
              <div className="space-y-1.5">
                {(() => {
                  const byG = {};
                  h.yearly.forEach(x => { byG[x.gid] = (byG[x.gid] || 0) + x.year; });
                  const all = Object.values(byG).reduce((s, v) => s + v, 0) || 1;
                  const parts = data.groups.filter(g => byG[g.id] > 0).map(g => ({ g, v: byG[g.id] })).sort((a, b) => b.v - a.v);
                  return (
                    <div className="space-y-1.5 pb-2">
                      <div className="flex rounded-full overflow-hidden" style={{ height: 12 }}>
                        {parts.map(({ g, v }) => <div key={g.id} style={{ width: `${v / all * 100}%`, background: GROUP_HEX[g.color] || '#787774' }} title={`${groupName(g)} ${fmt(v)}`}></div>)}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                        {parts.map(({ g, v }) => (
                          <span key={g.id} className="flex items-center gap-1.5 text-secondary"><span className="w-2 h-2 rounded-full" style={{ background: GROUP_HEX[g.color] || '#787774' }}></span>{groupName(g)} <span className="font-mono text-primary">{fmt(v)}</span></span>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {(showAllYearly ? h.yearly : h.yearly.slice(0, 6)).map(x => (
                  <div key={x.cat} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="truncate text-primary">{x.cat}</span>
                    <span className="font-mono text-secondary shrink-0">{x.every > 1 && <span className="font-sans text-[10px] text-tertiary me-1.5">{t('ycEvery', { n: x.every })}</span>}{fmtCents(x.amount).replace(/[.,]00(?=\D*$)/, '')} × {x.times} = <span className="text-primary font-semibold">{fmt(x.year)}</span></span>
                  </div>
                ))}
                {h.yearly.length > 6 && (
                  <button onClick={() => setShowAllYearly(v => !v)} className="text-[11px] text-notion-blue hover:underline">
                    {showAllYearly ? t('ycShowLess') : t('ycShowAll', { n: h.yearly.length })}
                  </button>
                )}
                <div className="flex justify-between text-[12px] border-t border-subtle pt-1.5">
                  <span className="text-secondary">{t('ycAll')}</span><span className="font-mono font-semibold text-primary">{fmt(h.yearly.reduce((s, x) => s + x.year, 0))}</span>
                </div>
                {h.subsYear > 0 && <div className="flex justify-between text-[12px]"><span className="text-secondary">{t('ycSubs')}</span><span className="font-mono text-primary">{fmt(h.subsYear)}</span></div>}
                {h.fees.length > 0 && (
                  <div className="flex justify-between text-[12px]"><span className="text-secondary">{t('ycFees')}</span><span className="font-mono text-notion-red">{fmt(h.fees.reduce((s, x) => s + x.total, 0))}</span></div>
                )}
              </div>
            ))}

            {sec('fa-hand-holding-dollar', t('dbTitle'), t('dbHint'), h.debts.length === 0 ? <p className="text-[12px] text-tertiary">{t('dbNone')}</p> : (
              <div className="space-y-1.5">
                {h.debts.map((i, n) => (
                  <div key={i.id} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="truncate text-primary">{n + 1}. {i.person}</span>
                    <span className="shrink-0 flex items-center gap-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${i.rate > 8 ? 'bg-red-500/15 text-notion-red' : 'bg-subtle text-secondary'}`}>{i.rate ? `${String(i.rate).replace('.', lang === 'en' ? '.' : ',')} %` : '0 %'}</span>
                      <span className="font-mono text-primary">{fmt(i.left)}</span>
                    </span>
                  </div>
                ))}
                {h.debts.some(i => i.rate > 8) && <p className="text-[11px] text-notion-red">{t('dbExpensive')}</p>}
              </div>
            ))}

            {sec('fa-chart-line', t('wtTitle'), t('wtHint'), (
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-[11px] text-secondary">{t('wtNow')}</span>
                  <span className={`text-[18px] font-semibold font-mono ${h.netWorth < 0 ? 'text-notion-red' : 'text-primary'}`}>{h.netWorth == null ? '–' : fmt(h.netWorth)}</span>
                </div>
                <div className="text-[11px] text-tertiary font-mono">{h.money == null ? '' : `${fmt(h.money)} − ${fmt(h.debtTotal)}${h.owedToUs > 0 ? ` + ${fmt(h.owedToUs)}` : ''}`}</div>
                {h.trend.length > 1 && (
                  <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full h-auto" style={{ maxWidth: 420 }} role="img" aria-label={t('wtTitle')}>
                    {tmin < 0 && <line x1="0" x2={W} y1={Y(0)} y2={Y(0)} stroke="currentColor" className="text-tertiary" strokeDasharray="3 3" strokeWidth="0.6" />}
                    <defs>
                      <linearGradient id="nwGrad" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#3b82f6" stopOpacity="0.35" /><stop offset="1" stopColor="#3b82f6" stopOpacity="0" /></linearGradient>
                    </defs>
                    <path d={`M ${X(0)} ${H - 6} ${h.trend.map((p, i) => `L ${X(i)} ${Y(p.v)}`).join(' ')} L ${X(h.trend.length - 1)} ${H - 6} Z`} fill="url(#nwGrad)" />
                    <polyline fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinejoin="round" points={h.trend.map((p, i) => `${X(i)},${Y(p.v)}`).join(' ')} />
                    {h.trend.map((p, i) => <circle key={i} cx={X(i)} cy={Y(p.v)} r={p.now ? 3.5 : 2} fill={p.now ? '#10b981' : '#3b82f6'} />)}
                    {h.trend.map((p, i) => (i === 0 || i === h.trend.length - 1 || i % 2 === 0) && (
                      <text key={'l' + i} x={X(i)} y={H + 11} textAnchor={i === 0 ? 'start' : i === h.trend.length - 1 ? 'end' : 'middle'} fontSize="9" fill="currentColor" className="text-tertiary">{lang === 'ar' ? (ALL_MONTHS.indexOf(p.label) + 1) : formatMonth(p.label, lang)}</text>
                    ))}
                  </svg>
                )}
              </div>
            ))}
          </>
        );
      };

      const renderWishlist = () => {
        const now = Date.now();
        const open = data.wishlist.filter(x => x.status === 'wait');
        const skipped = data.wishlist.filter(x => x.status === 'skipped');
        const savedBySkipping = skipped.reduce((s, x) => s + x.amount, 0);
        return panel({ id: 'wishlist', icon: 'fa-hourglass-half', title: t('wlTitle'), sub: savedBySkipping > 0 ? t('wlSaved', { amount: fmt(savedBySkipping) }) : t('wlSub') }, (
          <div className="space-y-2.5">
            <div className="flex gap-2">
              <input data-free value={wishName} onChange={(e) => setWishName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addWish()} placeholder={t('wlNamePh')}
                className="flex-1 min-w-0 bg-subtle border border-subtle rounded-lg px-2.5 py-2 text-[13px] text-primary outline-none focus:border-strong" />
              <input data-free value={wishAmount} onChange={(e) => setWishAmount(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addWish()} inputMode="decimal" placeholder="€" style={{ width: 80 }}
                className="shrink-0 bg-subtle border border-subtle rounded-lg px-2.5 py-2 text-[13px] text-primary text-end font-mono outline-none focus:border-strong" />
              <button onClick={addWish} aria-label={t('wlAdd')} className="w-10 rounded-lg bg-primary text-surface"><i className="fa-solid fa-plus text-xs"></i></button>
            </div>
            {open.length === 0 && <p className="text-[12px] text-tertiary">{t('wlEmpty')}</p>}
            {open.map(x => {
              const left = new Date(x.added).getTime() + WISH_WAIT - now;
              const ready = left <= 0;
              return (
                <div key={x.id} className="flex items-center gap-2 rounded-xl bg-subtle/60 ps-3 pe-1.5 py-1.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-primary truncate">{x.name}</div>
                    <div className={`text-[11px] ${ready ? 'text-notion-green' : 'text-tertiary'}`}>{ready ? t('wlReady') : t('wlWait', { h: Math.ceil(left / 3600000) })}</div>
                  </div>
                  {x.amount > 0 && <span className="font-mono text-[12px] text-primary">{fmt(x.amount)}</span>}
                  {ready ? (
                    <>
                      <button onClick={() => decideWish(x.id, 'skipped')} className="px-2 py-1 rounded-lg bg-notion-green/15 text-notion-green text-[11px] font-medium">{t('wlSkip')}</button>
                      <button onClick={() => decideWish(x.id, 'bought')} className="px-2 py-1 rounded-lg bg-surface text-secondary text-[11px]">{t('wlBuy')}</button>
                    </>
                  ) : (
                    <button onClick={() => decideWish(x.id, 'skipped')} className="px-2 py-1 rounded-lg bg-surface text-secondary text-[11px]">{t('wlSkip')}</button>
                  )}
                  <button onClick={() => removeWish(x.id)} aria-label={t('deleteCategoryBtn')} className="w-7 h-7 rounded-full text-tertiary hover:text-primary"><i className="fa-solid fa-xmark text-xs"></i></button>
                </div>
              );
            })}
            {skipped.length > 0 && <p className="text-[11px] text-secondary">{t('wlSkippedN', { n: skipped.length, amount: fmt(savedBySkipping) })}</p>}
          </div>
        ));
      };

      // Small entry on Overview and More that opens the Money health page.
      // ---- Data check: things that make the numbers less exact, each with a fix ----
      const dataIssues = (() => {
        if (nowIdx < 0) return [];
        const pos = TIMELINE[nowIdx];
        const out = [];
        const undatedBills = data.categories.expenses.filter(c => {
          const g = data.groups.find(x => x.id === getMeta('expenses', c).bracket);
          if (!g || g.kind !== 'fixed' || getMeta('expenses', c).oneTime || Number.isInteger(getMeta('expenses', c).payDay)) return false;
          const n = getNode('expenses', c, pos.yr, pos.m);
          return n.budget > 0 || n.actual > 0;
        });
        if (undatedBills.length) out.push({ id: 'undated', icon: 'fa-calendar-xmark', text: t('dcUndated', { n: undatedBills.length }), items: undatedBills.map(c => ({ label: c, fix: () => handleOpenEditCategory('expenses', c) })) });
        const checked = data.accounts.map(x => x.updated).filter(Boolean).sort().pop();
        if (checked && checked.slice(0, 7) === todayISO().slice(0, 7) && appNow != null && Math.abs(accountsTotal - appNow) >= 10) {
          out.push({ id: 'gap', icon: 'fa-scale-unbalanced', text: t('dcGap', { real: fmt(accountsTotal), app: fmt(appNow), diff: fmt(Math.abs(accountsTotal - appNow)) }),
            actions: [[t('dcUseReal'), useAccountsAsReal], [t('dcCheckAccounts'), () => setView('more')]] });
        }
        const seenLoan = {};
        (data.ious || []).forEach(i => { const k = (i.person || '').trim().toLowerCase() + '|' + i.amount + '|' + i.type; (seenLoan[k] = seenLoan[k] || []).push(i); });
        Object.values(seenLoan).filter(list => list.length > 1).forEach(list => {
          out.push({ id: 'dup' + list[0].id, icon: 'fa-clone', text: t('dcDupLoan', { person: list[0].person, amount: fmt(list[0].amount), n: list.length }),
            actions: [[t('dcReview'), () => setView('more')]] });
        });
        const unbooked = (data.ious || []).filter(i => !i.settled && loanMoneyState(i) === 'unknown');
        if (unbooked.length) out.push({ id: 'loanmoney', icon: 'fa-hand-holding-dollar', text: t('dcLoanMoney', { n: unbooked.length }), actions: [[t('dcReview'), () => setView('more')]] });
        const prefix = `${pos.yr}-${pad2(ALL_MONTHS.indexOf(pos.m) + 1)}-`;
        // Purchases saved with a month but no day: listed, each opens its entry to set the day.
        const undatedTx = (data.tx || []).filter(x => x.undated && x.type === 'expenses' && x.date.startsWith(prefix));
        if (undatedTx.length) out.push({ id: 'nodate' + pos.m + undatedTx.length, icon: 'fa-receipt', soft: true,
          text: t('dcNoDate', { n: undatedTx.length, amount: fmt(undatedTx.reduce((a2, x) => a2 + x.amount, 0)) }),
          items: undatedTx.map(x => ({ label: `${x.cat} · ${fmtCents(x.amount)}`, fix: () => openEntry(x.id) })) });
        ['expenses', 'incomes'].forEach(type => lookAlikes(type).forEach(([a, b]) => {
          const [keep, drop] = itemWeight(type, a) >= itemWeight(type, b) ? [a, b] : [b, a];
          out.push({ id: 'same|' + type + '|' + [a, b].sort().join('|'), icon: 'fa-object-group', soft: true, text: t('dcSame', { a: drop, b: keep }),
            actions: [[t('dcMergeInto', { name: keep }), () => mergeItems(type, drop, keep)], [t('dcMergeInto', { name: drop }), () => mergeItems(type, keep, drop)]] });
        }));
        return out.filter(x => !dismissed['dc_' + x.id]);
      })();
      // ---- Month-end review: how last month went against the plan ----
      const review = (() => {
        if (nowIdx < 1) return null;
        const row = forwardTimeline[nowIdx - 1];
        if (!row) return null;
        const { year: yr, month: m } = row;
        const groups = data.groups.map(g => {
          const cats = data.categories.expenses.filter(c => getMeta('expenses', c).bracket === g.id);
          const real = cats.reduce((sum, c) => sum + getNode('expenses', c, yr, m).actual, 0);
          const plan = g.kind === 'variable' ? getTarget(g.id, yr, m) + cats.filter(c => getMeta('expenses', c).oneTime).reduce((sum, c) => sum + getNode('expenses', c, yr, m).budget, 0)
            : cats.reduce((sum, c) => sum + getNode('expenses', c, yr, m).budget, 0);
          return { g, real, plan, diff: real - plan };
        }).filter(x => x.real > 0 || x.plan > 0);
        const items = data.categories.expenses.map(c => ({ cat: c, v: getNode('expenses', c, yr, m).actual })).filter(x => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 3);
        const planIn = data.categories.incomes.reduce((sum, c) => sum + getNode('incomes', c, yr, m).budget, 0);
        const planOut = groups.reduce((sum, x) => sum + x.plan, 0);
        return { yr, m, inReal: row.actualIn, outReal: row.actualEx, planIn, planOut, net: row.actualIn - row.actualEx, end: row.endProjectedBalance,
          groups: groups.sort((a, b) => b.diff - a.diff), surprises: groups.filter(x => x.diff > 20).sort((a, b) => b.diff - a.diff).slice(0, 3), items };
      })();
      const renderReview = (always = false) => {
        const r = review;
        if (!r) return null;
        const key = `review_${r.yr}_${r.m}`;
        // On Overview only during the first ten days of the new month, until closed.
        if (!always && (new Date().getDate() > 10 || dismissed[key])) return null;
        const mon = `${formatMonth(r.m, lang)} ${r.yr}`;
        const maxV = Math.max(1, ...r.groups.map(x => Math.max(x.real, x.plan)));
        return panel({ id: 'review', icon: 'fa-flag-checkered', title: t('rvTitle', { month: mon }), sub: t(r.net >= 0 ? 'rvSubPlus' : 'rvSubMinus', { amount: fmt(Math.abs(r.net)) }),
          right: !always && <button onClick={() => dismiss(key)} className="px-2.5 py-1 rounded-full bg-subtle text-[11px] text-secondary hover:text-primary">{t('rvDone')}</button> }, (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {[[t('rvIn'), r.inReal, r.planIn, 'text-notion-green'], [t('rvOut'), r.outReal, r.planOut, 'text-primary'], [t('rvNet'), r.net, null, r.net >= 0 ? 'text-notion-green' : 'text-notion-red']].map(([l, v, pl, cls]) => (
                <div key={l} className="rounded-xl bg-subtle/70 px-2.5 py-2 min-w-0">
                  <div className="text-[10.5px] text-secondary truncate">{l}</div>
                  <div className={`text-[14px] font-semibold font-mono truncate ${cls}`}>{fmt(v)}</div>
                  {pl != null && <div className="text-[10px] text-tertiary font-mono truncate">{t('rvPlanned')} {fmt(pl)}</div>}
                </div>
              ))}
            </div>
            {r.surprises.length > 0 && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-primary space-y-0.5">
                <div className="font-semibold">{t('rvSurprises')}</div>
                {r.surprises.map(x => <div key={x.g.id} className="flex justify-between gap-2"><span className="truncate">{groupName(x.g)}</span><span className="font-mono text-notion-red shrink-0">+ {fmt(x.diff)}</span></div>)}
              </div>
            )}
            <div className="space-y-2">
              {r.groups.map(x => (
                <div key={x.g.id} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-[12px]">
                    <span className="text-primary truncate">{groupName(x.g)}</span>
                    <span className="font-mono shrink-0"><span className="text-primary">{fmt(x.real)}</span> <span className="text-tertiary">/ {fmt(x.plan)}</span></span>
                  </div>
                  <div className="relative h-2 rounded-full bg-subtle overflow-hidden">
                    <div className="absolute inset-y-0 start-0 rounded-full" style={{ width: `${x.real / maxV * 100}%`, background: x.plan > 0 && x.real > x.plan + 0.5 ? '#ef4444' : (GROUP_HEX[x.g.color] || '#3b82f6') }}></div>
                    {x.plan > 0 && <div className="absolute inset-y-0 w-0.5 bg-primary/70" style={{ insetInlineStart: `${Math.min(99.5, x.plan / maxV * 100)}%` }}></div>}
                  </div>
                </div>
              ))}
            </div>
            {r.items.length > 0 && (
              <div className="text-[12px] text-secondary">{t('rvBiggest')} {r.items.map(x => `${x.cat} ${fmt(x.v)}`).join(' · ')}</div>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <button onClick={() => setView('more')} className="px-3 py-1.5 rounded-full bg-primary text-surface text-[12px] font-semibold">{t('rvCheckBal')}</button>
              <button onClick={openBalanceModal} className="px-3 py-1.5 rounded-full bg-subtle text-[12px] text-primary">{t('fixBalanceBtn')}</button>
            </div>
            <p className="text-[11px] text-tertiary">{t('rvHint')}</p>
          </div>
        ));
      };

      // ---- AI suggestions: a short month summary goes to Claude, a few tips come back ----
      const tipsKey = `budget_ai_tips_${activeHousehold}`;
      const [aiTips, setAiTips] = useState(() => { try { return JSON.parse(safeStorage.get(tipsKey, 'null')); } catch (e) { return null; } });
      const [tipsBusy, setTipsBusy] = useState(false);
      const buildTipsSummary = () => {
        const pos = TIMELINE[Math.max(0, nowIdx)];
        const row = forwardTimeline[Math.max(0, nowIdx)];
        const groups = data.groups.map(g => {
          const cats = data.categories.expenses.filter(c => getMeta('expenses', c).bracket === g.id);
          const spent = cats.reduce((sum, c) => sum + getNode('expenses', c, pos.yr, pos.m).actual, 0);
          const plan = g.kind === 'variable' ? getTarget(g.id, pos.yr, pos.m) : cats.reduce((sum, c) => sum + getNode('expenses', c, pos.yr, pos.m).budget, 0);
          return { group: groupName(g), kind: g.kind, plan: round2(plan), spent: round2(spent) };
        }).filter(x => x.plan || x.spent);
        const a = afterBills;
        return JSON.stringify({
          today: todayISO(), month: `${pos.m} ${pos.yr}`, dayOfMonth: new Date().getDate(),
          household: { members: [data.members.me, data.members.partner] },
          balanceStart: row?.startBal, receivedSoFar: row?.actualIn, spentSoFar: row?.actualEx, expectedIncome: row?.projectedIn, expectedSpending: row?.projectedEx, expectedEndBalance: row?.endProjectedBalance,
          realAccountsTotal: data.accounts.some(x => x.updated) ? accountsTotal : null,
          groups,
          toSpendUntilPayday: a && a.isNow ? { amount: round2(a.spendable), until: a.untilDay, perDay: round2(a.perDay) } : null,
          openBills: data.categories.expenses.filter(c => !isReceiptItem(c)).map(c => ({ c, n: getNode('expenses', c, pos.yr, pos.m), d: getMeta('expenses', c).payDay })).filter(x => x.n.budget > 0 && x.n.actual === 0).map(x => ({ name: x.c, amount: x.n.budget, day: x.d || null })),
          emergencyFundMonths: health?.months != null ? Math.round(health.months * 10) / 10 : null,
          savingsRateLastMonths: health ? health.rates.filter(r => !r.now && r.rate != null).map(r => ({ month: r.m, rate: Math.round(r.rate * 100) })) : [],
          debts: (data.ious || []).filter(i => !i.settled).map(i => ({ person: i.person, amount: i.amount, type: i.type })),
          wishlistWaiting: (data.wishlist || []).filter(w => w.status === 'wait').map(w => ({ name: w.name, amount: w.amount })),
          dataIssues: dataIssues.map(x => x.text)
        });
      };
      const fetchTips = async () => {
        if (!auth?.currentUser) { showToast(t('askNeedSignIn')); return; }
        setTipsBusy(true);
        try {
          const token = await auth.currentUser.getIdToken();
          const resp = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ mode: 'tips', lang, summary: buildTipsSummary() }) });
          const r = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            const key = { not_configured: 'askErrSetup', bad_api_key: 'askErrSetup', not_allowed: 'askErrNotAllowed', not_signed_in: 'askNeedSignIn', rate_limited: 'askErrBusy' }[r.error] || 'askErrGeneric';
            showToast(t(key)); return;
          }
          const v = { at: new Date().toISOString(), lang, tips: r.tips || [] };
          setAiTips(v); safeStorage.set(tipsKey, JSON.stringify(v));
        } catch (e) {
          console.error(e);
          showToast(t(navigator.onLine ? 'askErrGeneric' : 'askErrOffline'));
        } finally { setTipsBusy(false); }
      };
      const renderAiTips = () => {
        const tips = aiTips?.tips || [];
        const style = { warning: ['fa-triangle-exclamation', 'text-amber-500', 'bg-amber-500/10 border-amber-500/30'], idea: ['fa-lightbulb', 'text-notion-blue', 'bg-notion-blue/10 border-notion-blue/30'], good: ['fa-circle-check', 'text-notion-green', 'bg-emerald-500/10 border-emerald-500/30'] };
        const when = aiTips?.at ? new Date(aiTips.at).toLocaleString(lang === 'en' ? 'en-US' : lang === 'ar' ? 'ar-SY-u-nu-latn' : 'de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
        return panel({ id: 'aiTips', icon: 'fa-wand-magic-sparkles', title: t('tipsTitle'), sub: when ? t('tipsFrom', { when }) : t('tipsSub'),
          right: <button onClick={fetchTips} disabled={tipsBusy} className="px-3 py-1.5 rounded-full bg-primary text-surface text-[11px] font-semibold disabled:opacity-60">
            {tipsBusy ? <><i className="fa-solid fa-spinner fa-spin me-1"></i>{t('askThinking')}</> : tips.length ? t('tipsRefresh') : t('tipsGet')}
          </button> }, (
          <div className="space-y-2">
            {!tips.length && !tipsBusy && <p className="text-[12px] text-secondary leading-relaxed">{t('tipsIntro')}</p>}
            {tipsBusy && !tips.length && [0, 1, 2].map(i => <div key={i} className="h-14 rounded-xl bg-subtle/70 animate-pulse"></div>)}
            {tips.map((x, i) => {
              const [ic, col, box] = style[x.kind] || style.idea;
              return (
                <div key={i} className={`pop-in flex gap-2.5 rounded-xl border px-3 py-2.5 ${box}`} style={{ animationDelay: `${i * 60}ms` }}>
                  <i className={`fa-solid ${ic} ${col} text-[14px] mt-1`}></i>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-primary">{x.title}</div>
                    <div className="text-[12.5px] text-secondary leading-snug">{x.text}</div>
                  </div>
                </div>
              );
            })}
            {aiTips && aiTips.lang !== lang && tips.length > 0 && <p className="text-[11px] text-tertiary">{t('tipsOtherLang')}</p>}
          </div>
        ));
      };

      const renderDataCheck = () => {
        if (!dataIssues.length) return null;
        return panel({ id: 'dataCheck', icon: 'fa-stethoscope', title: t('dcTitle'), sub: t('dcSub', { n: dataIssues.length }), tone: dataIssues.some(x => !x.soft) ? 'warn' : undefined }, (
          <div className="space-y-2">
            {dataIssues.map(x => (
              <div key={x.id} className="rounded-xl bg-subtle/60 px-3 py-2.5 space-y-2">
                <div className="flex items-start gap-2.5">
                  <i className={`fa-solid ${x.icon} text-[13px] mt-0.5 ${x.soft ? 'text-tertiary' : 'text-amber-500'}`}></i>
                  <span className="flex-1 text-[12.5px] text-primary leading-snug">{x.text}</span>
                  <button onClick={() => dismiss('dc_' + x.id)} aria-label={t('dismiss')} className="w-6 h-6 shrink-0 rounded-full text-tertiary hover:text-primary"><i className="fa-solid fa-xmark text-[11px]"></i></button>
                </div>
                {x.items && (
                  <div className="flex flex-wrap gap-1.5 ps-6">
                    {x.items.map(it => (
                      <button key={it.label} onClick={it.fix} className="px-2.5 py-1 rounded-full bg-surface border border-subtle text-[11.5px] text-primary hover:border-notion-blue">
                        {it.label} <i className="fa-solid fa-pen text-[9px] ms-1 text-tertiary"></i>
                      </button>
                    ))}
                  </div>
                )}
                {x.actions && (
                  <div className="flex flex-wrap gap-1.5 ps-6">
                    {x.actions.map(([l, fn]) => <button key={l} onClick={fn} className="px-2.5 py-1 rounded-full bg-surface border border-subtle text-[11.5px] text-notion-blue">{l}</button>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ));
      };

      const renderHealthLink = () => {
        const h = health;
        if (!h) return null;
        const tone = h.months == null ? 'text-tertiary' : h.months >= 6 ? 'text-notion-green' : h.months >= 3 ? 'text-primary' : 'text-notion-red';
        const lastRate = [...h.rates].reverse().find(r => !r.now && r.rate != null);
        return (
          <button onClick={() => setView('health')} className="w-full text-start rounded-2xl border border-subtle bg-surface px-4 py-3 flex items-center gap-3 hover:bg-subtle/60 active:scale-[.99] transition">
            <span className="w-9 h-9 rounded-xl bg-subtle flex items-center justify-center text-notion-red shrink-0"><i className="fa-solid fa-heart-pulse text-[13px]"></i></span>
            <span className="flex-1 min-w-0">
              <span className="block text-[13px] font-semibold text-primary">{t('healthTitle')}</span>
              <span className="block text-[11px] text-secondary truncate">
                <span className={tone}>{h.months == null ? '–' : t('efMonths', { n: h.months.toFixed(1).replace('.', lang === 'en' ? '.' : ',') })}</span>
                {' · '}{t('srTitle')} {lastRate ? pct(lastRate.rate) : '–'}
                {data.wishlist.some(x => x.status === 'wait') ? ` · ${t('wlTitle').split(' (')[0]} ${data.wishlist.filter(x => x.status === 'wait').length}` : ''}
              </span>
            </span>
            <i className="fa-solid fa-chevron-right text-[11px] text-tertiary rtl:rotate-180"></i>
          </button>
        );
      };
      const renderHealthView = () => (
        <div className="grid grid-cols-1 gap-4 lg:gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
          <div className="space-y-4 min-w-0">
            {renderReview(true)}
            {renderHealth(['fa-umbrella', 'fa-piggy-bank', 'fa-scale-balanced', 'fa-chart-line'])}
            <div className="lg:hidden space-y-4">{renderHealth(['fa-chart-pie', 'fa-calendar-days', 'fa-hand-holding-dollar'])}</div>
          </div>
          <div className="space-y-4 min-w-0">
            {renderAiTips()}
            {renderDataCheck()}
            {renderWishlist()}
            <div className="hidden lg:block space-y-4">{renderHealth(['fa-chart-pie', 'fa-hand-holding-dollar', 'fa-calendar-days'])}</div>
          </div>
        </div>
      );

      const OV_DEFAULT = ['closeMonth', 'review', 'afterBills', 'splitUp', 'aiTips', 'due', 'dataCheck', 'meters', 'incomeEnd', 'forecast', 'healthLink'];
      const [ovOrder, setOvOrderState] = useState(() => {
        try { const v = JSON.parse(safeStorage.get('budget_ov_order', 'null')); if (Array.isArray(v)) {
          // New cards slot in where they sit by default, without disturbing the saved order.
          const out = v.filter(k => OV_DEFAULT.includes(k));
          OV_DEFAULT.forEach((k, i) => { if (!out.includes(k)) out.splice(Math.min(i, out.length), 0, k); });
          return out;
        } } catch (e) {}
        return OV_DEFAULT;
      });
      const [ovHidden, setOvHiddenState] = useState(() => { try { return JSON.parse(safeStorage.get('budget_ov_hidden', '{}')) || {}; } catch (e) { return {}; } });
      const setOvOrder = (v) => { setOvOrderState(v); safeStorage.set('budget_ov_order', JSON.stringify(v)); };
      const setOvHidden = (v) => { setOvHiddenState(v); safeStorage.set('budget_ov_hidden', JSON.stringify(v)); };
      const [arrangeOpen, setArrangeOpen] = useState(false);
      const OV_NAMES = { closeMonth: 'cmTitle', splitUp: 'suTitle', review: 'ovN_review', aiTips: 'tipsTitle', afterBills: 'abTitle', due: 'dueTitle', dataCheck: 'dcTitle', meters: 'thisMonth', incomeEnd: 'incomeEndTitle', forecast: 'forecastTitle', healthLink: 'healthTitle' };

      // ---- Month-end ritual: shown in the last 4 days of the month ----
      const [cmGoal, setCmGoal] = useState('');
      const renderCloseMonth = () => {
        if (!labs.closeMonth || nowIdx === -1) return null;
        const p = TIMELINE[nowIdx], dim = getDaysInMonth(p.yr, p.m), today = new Date().getDate();
        if (today < dim - 3) return null;
        const left = data.groups.filter(g => g.kind === 'variable').map(g => {
          const spent = data.categories.expenses.filter(c => getMeta('expenses', c).bracket === g.id && isReceiptItem(c)).reduce((sum, c) => sum + getNode('expenses', c, p.yr, p.m).actual, 0);
          const target = getTarget(g.id, p.yr, p.m);
          return { g, spent, target, left: round2(target - spent) };
        }).filter(x => x.target > 0);
        const leftover = round2(left.reduce((sum, x) => sum + Math.max(0, x.left), 0));
        const openBills = dueSoon.filter(x => x.off === 0);
        const checked = data.accounts.length && data.accounts.every(a => a.updated && a.updated >= todayISO().slice(0, 8) + pad2(Math.max(1, dim - 3)));
        const goal = data.goals.find(g => g.id === cmGoal) || data.goals[0];
        const step = (ok, text, action) => (
          <div className="flex items-start gap-2.5">
            <i className={`fa-solid ${ok ? 'fa-circle-check text-notion-green' : 'fa-circle text-tertiary'} text-[15px] mt-0.5`}></i>
            <div className="flex-1 min-w-0 text-[12.5px] text-primary leading-snug">{text}{action}</div>
          </div>
        );
        return panel({ id: 'closeMonth', icon: 'fa-flag-checkered', title: t('cmTitle', { month: formatMonth(p.m, lang) }), sub: t('cmSub', { n: dim - today }) }, (
          <div className="space-y-3">
            {step(checked, t('cmStepAccounts'), <button onClick={() => setView('more')} className="block text-notion-blue font-medium mt-0.5">{t('cmOpenAccounts')}</button>)}
            {step(!openBills.length, openBills.length ? t('cmStepBillsOpen', { n: openBills.length, amount: fmt(openBills.reduce((a2, b2) => a2 + b2.amount, 0)) }) : t('cmStepBillsDone'),
              openBills.length ? <span className="block text-[11px] text-tertiary">{openBills.slice(0, 4).map(x => x.cat).join(', ')}</span> : null)}
            {step(false, t('cmStepLeftover', { amount: fmt(leftover) }), (
              <div className="mt-1.5 space-y-1.5">
                {left.map(x => (
                  <div key={x.g.id} className="flex items-center justify-between text-[11.5px]">
                    <span className="text-secondary">{groupName(x.g)}</span>
                    <span className={`font-mono ${x.left < 0 ? 'text-notion-red' : 'text-primary'}`}>{x.left < 0 ? '−' : ''}{fmt(Math.abs(x.left))}</span>
                  </div>
                ))}
                {leftover > 0 && data.goals.length > 0 && (
                  <div className="flex items-center gap-2 pt-1">
                    <select data-free value={goal?.id || ''} onChange={(e) => setCmGoal(e.target.value)} style={{ flex: '1 1 0', minWidth: 0, width: 'auto' }}
                      className="bg-subtle border border-subtle rounded-lg px-2 py-1.5 text-[12px] text-primary">
                      {data.goals.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                    <button onClick={() => mutateWithUndo(d => { const g = d.goals.find(x => x.id === goal.id); if (g) g.saved = round2(g.saved + leftover); }, t('goalDeposited', { amount: fmtCents(leftover), name: goal.name }))}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-notion-blue text-white text-[12px] font-semibold">{t('cmToGoal', { amount: fmt(leftover) })}</button>
                  </div>
                )}
                {leftover > 0 && !data.goals.length && <span className="block text-[11px] text-tertiary">{t('cmNoGoal')}</span>}
              </div>
            ))}
          </div>
        ));
      };
      // ---- Who paid what between the two of you (this month, shared spending) ----
      const renderSplitUp = () => {
        if (!labs.splitUp || nowIdx === -1) return null;
        const p = TIMELINE[nowIdx], prefix = `${p.yr}-${pad2(ALL_MONTHS.indexOf(p.m) + 1)}-`;
        const mine = (w) => round2((data.tx || []).filter(x => x.type === 'expenses' && x.who === w && x.date.startsWith(prefix) && x.date <= todayISO()).reduce((sum, x) => sum + x.amount, 0));
        const me = mine('me'), partner = mine('partner'), joint = mine('joint');
        if (me + partner < 1) return null;
        const diff = round2((me - partner) / 2);
        const nameMe = whoLabel('me'), namePartner = whoLabel('partner');
        return panel({ id: 'splitUp', icon: 'fa-people-arrows', title: t('suTitle'), sub: formatMonth(p.m, lang) }, (
          <div className="space-y-2.5">
            {[[nameMe, me], [namePartner, partner], [t('whoJoint'), joint]].map(([n, v]) => (
              <div key={n} className="flex items-center justify-between text-[13px]"><span className="text-secondary">{n}</span><span className="font-mono text-primary">{fmt(v)}</span></div>
            ))}
            <div className="rounded-xl bg-subtle/60 px-3 py-2.5 text-[13px] text-primary">
              {Math.abs(diff) < 1 ? t('suEven') : t('suOwes', { who: diff > 0 ? namePartner : nameMe, to: diff > 0 ? nameMe : namePartner, amount: fmt(Math.abs(diff)) })}
              <span className="block text-[11px] text-tertiary mt-0.5">{t('suHint')}</span>
            </div>
          </div>
        ));
      };

      const renderOverview = () => {
        const { cm, carriedLabel, lines, availableNow, beforeStart, isPast, meters } = MB;
        const nowMode = availableNow !== null && balanceView === 'now';
        const hero = nowMode ? availableNow : cm.endProjectedBalance;
        // "So far" means up to today: entries booked for later days this month wait for their day.
        const inSoFar = round2(cm.actualIn - futureSplit.inn), outSoFar = round2(cm.actualEx - futureSplit.out);
        const stats = nowMode
          ? [[t('heroStart'), cm.startBal, ''], [t('nowReceived'), inSoFar, '+'], [t('nowPaid'), outSoFar, '−']]
          : [[t('heroStart'), cm.startBal, ''], [t('heroIn'), cm.projectedIn, '+'], [t('heroOut'), cm.projectedEx, '−']];
        const detailRows = nowMode
          ? [
              { label: carriedLabel, text: fmtBalance(cm.startBal), cls: 'text-primary' },
              { label: t('nowReceived'), text: `+ ${fmt(inSoFar)}`, cls: 'text-notion-green' },
              { label: t('nowPaid'), text: `− ${fmt(outSoFar)}`, cls: 'text-notion-red' }
            ]
          : lines;
        const quick = [
          ['fa-heart-pulse', t('healthTitle'), () => setView('health')],
          ['fa-file-import', t('quickImport'), openImport],
          ['fa-wand-magic-sparkles', t('quickAsk'), () => { setAskError(''); setAskModal(true); }],
          ['fa-clock-rotate-left', t('quickHistory'), () => { setActivityTab('history'); setView('activity'); }]
        ];
        // Cards below the balance, in the order chosen under "Arrange cards".
        const cards = {
          review: () => renderReview(), aiTips: () => renderAiTips(), afterBills: () => renderAfterBills(), due: () => renderDue(), dataCheck: () => renderDataCheck(),
          meters: () => panel({ id: 'meters', icon: 'fa-gauge-high', title: t('thisMonth') }, (
                <div className="space-y-3.5">
                  {meters.map(mt => (
                    <div key={mt.label} className="space-y-1.5">
                      <div className="flex items-baseline justify-between gap-2 text-[13px]">
                        <span className="font-medium text-primary">{mt.label}</span>
                        <span className="font-mono text-primary">{fmt(mt.done)} <span className="text-tertiary">/ {fmt(mt.total)}</span></span>
                      </div>
                      <div className="h-2 rounded-full bg-subtle overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${mt.total > 0 ? Math.min(100, (mt.done / mt.total) * 100) : 0}%`, background: mt.color }}></div>
                      </div>
                      <div className={`text-[11px] ${mt.over ? 'text-notion-red' : 'text-tertiary'}`}>{mt.sub}</div>
                    </div>
                  ))}
                </div>
              )),
          incomeEnd: () => renderIncomeEnd(true), forecast: () => renderForecast(), healthLink: () => renderHealthLink(),
          closeMonth: () => renderCloseMonth(), splitUp: () => renderSplitUp()
        };
        const shown = ovOrder.filter(k => cards[k] && !ovHidden[k]);
        const col = (rest) => shown.filter((_, i) => i % 2 === rest).map(k => <React.Fragment key={k}>{cards[k]()}</React.Fragment>);
        return (
          <div className="grid grid-cols-1 gap-4 lg:gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
            <div className="space-y-4 min-w-0">
              {labs.reminders && reminders.length > 0 && (
                <section className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <i className="fa-solid fa-bell text-amber-500 text-[13px]"></i>
                    <span className="flex-1 text-[13.5px] font-semibold text-primary">{t('remTitle', { n: reminders.length })}</span>
                    {notifPerm === 'default' && <button onClick={askNotif} className="text-[11.5px] text-notion-blue font-medium">{t('remAllow')}</button>}
                  </div>
                  {reminders.map(r => (
                    <div key={r.kind + r.cat} className="flex items-center gap-2.5 rounded-xl bg-surface/80 px-2.5 py-2">
                      <ItemIcon spec={iconFor(r.kind === 'bill' ? 'expenses' : 'incomes', r.cat)} tint={tintFor(r.kind === 'bill' ? 'expenses' : 'incomes', r.cat)} size={26} />
                      <button onClick={() => showItem(r.kind === 'bill' ? 'expenses' : 'incomes', r.cat)} className="flex-1 min-w-0 text-start">
                        <span className="block text-[13px] text-primary truncate">{r.cat}</span>
                        <span className={`block text-[11px] ${r.when === 'overdue' || r.when === 'late' ? 'text-notion-red' : 'text-secondary'}`}>{t('rem_' + r.when)}{r.day ? ` · ${t('kDueDay', { d: r.day })}` : ''}</span>
                      </button>
                      <span className="font-mono text-[13px] text-primary">{fmtCents(r.amount)}</span>
                      <button onClick={() => toggleDone(r.kind === 'bill' ? 'expenses' : 'incomes', r.cat)} className="shrink-0 px-2.5 py-1 rounded-full bg-notion-blue text-white text-[11.5px] font-semibold">
                        {t(r.kind === 'bill' ? 'itemMarkPaid' : 'itemMarkReceived')}
                      </button>
                    </div>
                  ))}
                </section>
              )}
              {noAccess && (
                <section className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-2">
                  <div className="text-[14px] font-semibold text-primary"><i className="fa-solid fa-lock me-2 text-amber-500"></i>{t('noAccessTitle')}</div>
                  <p className="text-[12px] text-secondary leading-relaxed">{t('noAccessText', { email: user?.email || '' })}</p>
                  <button onClick={handleSignOut} className="px-3 py-1.5 rounded-lg bg-surface border border-subtle text-[12px] text-primary">{t('signOut')}</button>
                </section>
              )}
              {householdId !== HOUSEHOLD_IDS[0] && !dismissed['hh_' + householdId] && (
                <section className="rounded-2xl border border-notion-blue/40 bg-notion-blue/5 p-4 space-y-3">
                  <div className="text-[14px] font-semibold text-primary">👋 {t('hhWelcome')}</div>
                  <p className="text-[12px] text-secondary leading-relaxed">{t('hhWelcomeText')}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input data-free defaultValue={data.name} placeholder={t('hhNamePh')} onBlur={(e) => { const v = e.target.value.trim(); if (v) mutate(d => { d.name = v.slice(0, 60); }); }}
                      className="bg-surface border border-subtle rounded-lg px-2.5 py-2 text-[13px] text-primary outline-none focus:border-strong" />
                    {['me', 'partner'].map(w => (
                      <input data-free key={w} defaultValue={data.members[w]} placeholder={t(w === 'me' ? 'hhMePh' : 'hhPartnerPh')}
                        onBlur={(e) => { const v = e.target.value.trim(); if (v) mutate(d => { d.members[w] = v; }); }}
                        className="bg-surface border border-subtle rounded-lg px-2.5 py-2 text-[13px] text-primary outline-none focus:border-strong" />
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] text-tertiary">{t('hhWelcomeHint')}</p>
                    <button onClick={applyStarterKit} className="shrink-0 px-3 py-1.5 rounded-lg bg-notion-blue text-white text-[12px] font-semibold">{t('starterBtn')}</button>
                    <button onClick={() => dismiss('hh_' + householdId)} className="shrink-0 px-3 py-1.5 rounded-lg bg-primary text-surface text-[12px] font-semibold">{t('hhDone')}</button>
                  </div>
                </section>
              )}
              <section className="rounded-2xl border border-subtle bg-surface p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[12px] text-secondary">
                      {nowMode ? t('nowTitle') : t(isPast ? 'endOfMonthTitlePast' : 'endOfMonthTitle', { month: monthLabel(selectedYear, selectedMonth) })}
                    </div>
                    <div className={`mt-1.5 text-[40px] leading-none font-semibold tracking-tight font-mono transition-colors ${beforeStart ? 'text-tertiary' : hero < 0 ? 'text-notion-red' : 'text-primary'}`}>
                      <AnimatedNumber value={hero} format={fmtBalance} />
                    </div>
                    {beforeStart && <div className="text-[11px] text-tertiary mt-2">{t('beforeStart')}</div>}
                    {cm.backCalculated && (() => {
                      const [ay, am] = (data.startingMonth || '').split('|');
                      return <div className="text-[11px] text-tertiary mt-2">{t('backCalcNote', { month: monthLabel(parseInt(ay), am) })}</div>;
                    })()}
                  </div>
                  {availableNow !== null && (
                    <Segmented size="sm" options={[['end', t('viewEnd')], ['now', t('viewNow')]]} value={balanceView} onChange={setBalanceView} />
                  )}
                </div>
                {!beforeStart && (
                  <div className="grid grid-cols-3 gap-2">
                    {stats.map(([label, v, sign]) => (
                      <div key={label} className="rounded-xl bg-subtle/70 px-3 py-2.5 min-w-0">
                        <div className="text-[11px] text-secondary truncate">{label}</div>
                        <div className={`mt-0.5 text-[13px] font-semibold font-mono truncate ${sign === '+' ? 'text-notion-green' : sign === '−' ? 'text-notion-red' : 'text-primary'}`}>
                          {sign ? `${sign} ` : ''}<AnimatedNumber value={v} format={fmtBalance} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {heroDetails && !beforeStart && (
                  <div className="rounded-xl border border-subtle p-3 text-xs font-mono space-y-1.5">
                    {detailRows.map(l => (
                      <div key={l.label} className="flex items-center justify-between gap-3">
                        <span className="font-sans text-secondary">{l.label}</span><span className={l.cls}>{l.text}</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-3 border-t border-strong pt-1.5 font-semibold">
                      <span className="font-sans text-primary">= {nowMode ? t('viewNow') : t('kpiCumulative')}</span>
                      <span className={hero < 0 ? 'text-notion-red' : 'text-primary'}>{fmtBalance(hero)}</span>
                    </div>
                    {nowMode ? (
                      // From now to month end: what's still coming in and still going out.
                      <div className="space-y-1 text-tertiary pt-1">
                        <div className="flex items-center justify-between gap-3"><span className="font-sans">{t('stillIn')}</span><span>+ {fmt(Math.max(0, cm.projectedIn - inSoFar))}</span></div>
                        <div className="flex items-center justify-between gap-3"><span className="font-sans">{t('stillOut')}</span><span>− {fmt(Math.max(0, cm.projectedEx - outSoFar))}</span></div>
                        <div className="flex items-center justify-between gap-3"><span className="font-sans">{t('endOfMonthTitle', { month: monthLabel(selectedYear, selectedMonth) })}</span><span>{fmtBalance(cm.endProjectedBalance)}</span></div>
                      </div>
                    ) : availableNow !== null && (
                      <div className="flex items-center justify-between gap-3 text-tertiary pt-1">
                        <span className="font-sans">{t('availableNow')}</span><span>{fmt(availableNow)}</span>
                      </div>
                    )}
                    <div className="pt-1 font-sans"><Hint label={t('howCalc')} text={nowMode ? t('nowRules') : t('expectedRules')} /></div>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <button onClick={() => setHeroDetails(v => !v)} aria-expanded={heroDetails} className="text-[12px] text-secondary hover:text-primary">
                    <i className={`fa-solid fa-chevron-down text-[9px] me-1.5 transition-transform ${heroDetails ? 'rotate-180' : ''}`}></i>
                    {heroDetails ? t('heroHide') : t('heroDetails')}
                  </button>
                  <button onClick={openBalanceModal} className="text-[12px] text-notion-blue hover:underline">✎ {t('fixBalanceBtn')}</button>
                </div>
              </section>

              <div className="grid grid-cols-4 gap-2">
                {quick.map(([icon, label, fn]) => (
                  <button key={label} onClick={fn} className="rounded-2xl border border-subtle bg-surface py-3 flex flex-col items-center gap-1.5 hover:bg-subtle active:scale-[.98] transition">
                    <span className="w-9 h-9 rounded-full bg-subtle flex items-center justify-center text-primary"><i className={`fa-solid ${icon} text-[13px]`}></i></span>
                    <span className="text-[11px] font-medium text-primary">{label}</span>
                  </button>
                ))}
              </div>

              <div className="lg:hidden space-y-4">{shown.map(k => <React.Fragment key={k}>{cards[k]()}</React.Fragment>)}</div>
              <div className="hidden lg:block space-y-4">{col(0)}</div>
              <button onClick={() => setArrangeOpen(true)} className="w-full py-2 rounded-xl border border-dashed border-strong text-[12px] text-secondary hover:text-primary">
                <i className="fa-solid fa-sliders me-2"></i>{t('ovArrange')}
              </button>
            </div>

            <div className="hidden lg:block space-y-4 min-w-0">
              {col(1)}
            </div>
          </div>
        );
      };

      const renderMonth = () => {
        const { cm, visibleIncomes, hiddenIncomes, activeGroups, emptyGroups } = MB;
        const incomeCard = (
          <section className="rounded-2xl border border-subtle bg-surface p-1.5">
            <div className="flex items-center justify-between px-2.5 pt-2 pb-1.5">
              <h2 className="text-[13px] font-semibold text-primary">{t('incomesHeader')}</h2>
              <span className="text-[13px] font-mono font-semibold text-notion-green">{fmt(cm.projectedIn)}</span>
            </div>
            {visibleIncomes.map(cat => renderItemRow('incomes', cat, 'income'))}
            {visibleIncomes.length === 0 && <p className="px-2.5 py-2 text-[11px] text-tertiary">{t('groupNothingPlanned')}</p>}
            <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-1 text-[11px]">
              {hiddenIncomes > 0 ? (
                <button onClick={() => setShowEmpty(p => ({ ...p, __incomes: !p.__incomes }))} className="text-tertiary hover:text-primary">
                  <i className={`fa-solid ${showEmpty.__incomes ? 'fa-eye-slash' : 'fa-eye'} me-1 text-[10px]`}></i>
                  {showEmpty.__incomes ? t('hideEmpty') : t('emptyItems', { n: hiddenIncomes })}
                </button>
              ) : <span></span>}
              <button onClick={() => startNewItem('incomes')} className="text-notion-blue font-medium hover:underline">{t('addItemShort')}</button>
            </div>
          </section>
        );
        const iconBtn = 'h-8 w-8 rounded-lg border border-subtle bg-surface text-secondary hover:text-primary hover:bg-subtle';
        return (
          <div className="space-y-4">
            {!dismissed.gestureTip && (
              <div className="lg:hidden flex items-center gap-3 rounded-2xl border border-subtle bg-surface px-3.5 py-2.5">
                <i className="fa-solid fa-hand-pointer text-notion-blue"></i>
                <span className="flex-1 text-[12px] text-secondary leading-snug">{t('gestureTip')}</span>
                <button onClick={() => dismiss('gestureTip')} aria-label={t('dismiss')} className="w-7 h-7 rounded-full text-tertiary hover:bg-subtle"><i className="fa-solid fa-xmark text-xs"></i></button>
              </div>
            )}
            {renderCalendar(true)}
            <div className="lg:hidden">
              <Segmented full options={[['expenses', t('expensesHeader'), fmt(cm.projectedEx)], ['incomes', t('incomesHeader'), fmt(cm.projectedIn)]]} value={monthPane} onChange={setMonthPane} />
            </div>
            <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)] items-start">
              <div className={`${monthPane === 'incomes' ? '' : 'hidden'} lg:block lg:sticky lg:top-20 min-w-0`}>{incomeCard}</div>
              <div className={`${monthPane === 'expenses' ? '' : 'hidden'} lg:block space-y-3 min-w-0`}>
                <div className="hidden lg:flex items-center justify-between">
                  <h2 className="text-[13px] font-semibold text-primary">{t('expensesHeader')}</h2>
                  <span className="text-[13px] font-mono font-semibold text-notion-red">{fmt(cm.projectedEx)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <Segmented size="sm" options={[['all', t('filterAll')], ['fixed', t('filterFixed')], ['variable', t('filterVariable')]]} value={expFilter} onChange={setExpFilter} />
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => startNewItem('expenses')} className="h-8 px-3 rounded-lg bg-primary text-surface text-[12px] font-semibold">{t('addItemBtn')}</button>
                    <button onClick={() => openGroupModal()} title={t('newGroup')} aria-label={t('newGroup')} className={iconBtn}><i className="fa-solid fa-folder-plus text-xs"></i></button>
                    <button onClick={toggleAllBrackets} title={anyGroupClosed ? t('expandAll') : t('collapseAll')} aria-label={anyGroupClosed ? t('expandAll') : t('collapseAll')} className={iconBtn}><i className="fa-solid fa-up-down text-xs"></i></button>
                  </div>
                </div>
                {activeGroups.map(renderGroup)}
                {emptyGroups.length > 0 && (
                  <div className="rounded-2xl border border-dashed border-strong/60 p-3">
                    <button onClick={() => setShowEmpty(p => ({ ...p, __groups: !p.__groups }))} aria-expanded={!!showEmpty.__groups}
                      className="w-full flex items-center justify-between text-[12px] text-secondary hover:text-primary">
                      <span>{t('emptyGroups', { n: emptyGroups.length })}</span>
                      <i className={`fa-solid fa-chevron-down text-[10px] transition-transform ${showEmpty.__groups ? '' : '-rotate-90'}`}></i>
                    </button>
                    {showEmpty.__groups && <div className="mt-3 space-y-3">{emptyGroups.map(renderGroup)}</div>}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      };

      // ---- Calendar: every payment of the month on its day – bills and subscriptions on their due day, receipts on theirs ----
      const calModel = useMemo(() => {
        const yr = selectedYear, m = selectedMonth, mi = ALL_MONTHS.indexOf(m);
        const days = getDaysInMonth(yr, m);
        const prefix = `${yr}-${pad2(mi + 1)}-`;
        const ev = {}; const undated = [];
        const push = (d, e) => (ev[d] || (ev[d] = [])).push(e);
        const txSum = {};
        (data.tx || []).filter(x => x.date.startsWith(prefix)).forEach(x => {
          txSum[x.type + '|' + x.cat] = (txSum[x.type + '|' + x.cat] || 0) + x.amount;
          const e = { key: x.id, txId: x.id, type: x.type, cat: x.cat, amount: x.amount, note: x.note, who: x.who, account: x.account,
            kind: x.source === 'tick' ? (x.type === 'incomes' ? 'income' : 'bill') : x.source === 'legacy' ? 'earlier' : x.source === 'loan' ? 'loan' : 'receipt' };
          if (x.undated) undated.push(e); else push(+x.date.slice(8, 10), e);
        });
        (data.transfers || []).filter(x => x.date.startsWith(prefix)).forEach(x => {
          push(+x.date.slice(8, 10), { key: x.id, trId: x.id, type: 'transfer', cat: '', amount: x.amount, note: x.note, from: x.from, to: x.to, kind: 'transfer' });
        });
        TYPES.forEach(type => data.categories[type].forEach(cat => {
          const n = getNode(type, cat, yr, m);
          const pd = getMeta(type, cat).payDay;
          const day = Number.isInteger(pd) ? Math.min(Math.max(pd, 1), days) : null;
          const rest = round2(n.actual - (txSum[type + '|' + cat] || 0));
          const receiptItem = type === 'expenses' && isReceiptItem(cat);
          if (rest > 0.005) {
            const e = { key: type + cat, type, cat, amount: rest, kind: type === 'incomes' ? 'income' : receiptItem ? 'spent' : 'bill' };
            if (day) push(day, e); else undated.push(e);
          } else if (n.actual <= 0 && n.budget > 0 && !receiptItem) {
            const e = { key: type + cat, type, cat, amount: n.budget, kind: type === 'incomes' ? 'income' : 'bill', planned: true };
            if (day) push(day, e); else undated.push(e);
          }
        }));
        const sum = (list, pred) => list.filter(pred).reduce((s2, e) => s2 + e.amount, 0);
        const byDay = {};
        for (let d = 1; d <= days; d++) {
          const list = (ev[d] || []).sort((p1, p2) => (p1.planned ? 1 : 0) - (p2.planned ? 1 : 0) || (p1.type === 'incomes' ? -1 : 1));
          byDay[d] = { list, out: sum(list, e => e.type === 'expenses' && !e.planned), inc: sum(list, e => e.type === 'incomes' && !e.planned),
            due: sum(list, e => e.type === 'expenses' && e.planned), dueIn: sum(list, e => e.type === 'incomes' && e.planned) };
        }
        const all = Object.values(byDay);
        return { yr, m, mi, days, prefix, byDay, undated,
          lead: (new Date(yr, mi, 1).getDay() + 6) % 7,
          out: all.reduce((s2, o) => s2 + o.out, 0) + sum(undated, e => e.type === 'expenses' && !e.planned),
          inc: all.reduce((s2, o) => s2 + o.inc, 0) + sum(undated, e => e.type === 'incomes' && !e.planned),
          due: all.reduce((s2, o) => s2 + o.due, 0) + sum(undated, e => e.type === 'expenses' && e.planned),
          maxOut: Math.max(1, ...all.map(o => o.out)) };
      }, [data, selectedYear, selectedMonth]);

      const renderCalendar = (inMonth = false) => {
        const c = calModel;
        const loc = lang === 'en' ? 'en-US' : lang === 'ar' ? 'ar-SY-u-nu-latn' : 'de-DE';
        const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(loc, { weekday: 'narrow' }).format(new Date(2024, 0, 1 + i)));
        const todayIso = todayISO();
        const sel = calDay && calDay.startsWith(c.prefix) ? calDay : (todayIso.startsWith(c.prefix) ? todayIso : null);
        const selDay = sel ? c.byDay[+sel.slice(8, 10)] : null;
        const accName = (id) => data.accounts.find(a => a.id === id)?.name || '';
        const short = (v) => v >= 1000 ? `${(v / 1000).toFixed(1).replace('.', lang === 'en' ? '.' : ',')}k` : String(Math.round(v));
        const kindLabel = (e) => e.planned ? (e.type === 'incomes' ? t('calExpected') : t('calDue')) : t('calKind_' + e.kind);
        const row = (e) => e.type === 'transfer' ? (
          <div key={e.key} className="flex items-center gap-2.5 rounded-xl ps-2 pe-1.5 py-1.5 bg-subtle/30 border border-subtle">
            <span className="w-7 h-7 rounded-[9px] bg-subtle flex items-center justify-center text-secondary shrink-0"><i className="fa-solid fa-right-left text-[11px]"></i></span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-primary truncate">{accName(e.from)} → {accName(e.to)}{e.note ? <span className="text-tertiary"> · {e.note}</span> : null}</div>
              <div className="text-[11px] text-tertiary">{t('calKind_transfer')}</div>
            </div>
            <span className="font-mono text-[13px] text-secondary">{fmtCents(e.amount)}</span>
            <button onClick={() => deleteTransfer(e.trId)} aria-label={t('deleteCategoryBtn')} className="w-7 h-7 rounded-full text-tertiary hover:text-notion-red"><i className="fa-solid fa-xmark text-xs"></i></button>
          </div>
        ) : (
          <div key={e.key} className={`flex items-center gap-2.5 rounded-xl ps-2 pe-1.5 py-1.5 ${e.planned ? 'border border-dashed border-strong' : 'bg-subtle/50'}`}>
            <ItemIcon spec={iconFor(e.type, e.cat)} tint={tintFor(e.type, e.cat)} size={28} />
            <div className="flex-1 min-w-0">
              <div className={`text-[13px] truncate ${e.planned ? 'text-secondary' : 'text-primary'}`}>{e.cat}{e.note ? <span className="text-tertiary"> · {e.note}</span> : null}</div>
              <div className="text-[11px] text-tertiary truncate">{[kindLabel(e), e.who ? whoLabel(e.who) : '', accName(e.account)].filter(Boolean).join(' · ')}</div>
            </div>
            <span className={`font-mono text-[13px] font-semibold ${e.planned ? 'text-tertiary' : e.type === 'incomes' ? 'text-notion-green' : 'text-primary'}`}>{e.type === 'incomes' ? '+' : '−'} {fmtCents(e.amount)}</span>
            {e.txId && <button onClick={() => deleteTx(e.txId)} aria-label={t('deleteCategoryBtn')} className="w-7 h-7 rounded-full text-tertiary hover:text-notion-red"><i className="fa-solid fa-xmark text-xs"></i></button>}
          </div>
        );
        // Colour of a day: the groups that money went to, as a little stacked bar.
        const segs = (o) => {
          const by = {};
          o.list.forEach(e => {
            if (e.planned || e.type !== 'expenses') return;
            const col = tintFor('expenses', e.cat);
            by[col] = (by[col] || 0) + e.amount;
          });
          const tot = Object.values(by).reduce((x, y) => x + y, 0) || 1;
          return Object.entries(by).sort((x, y) => y[1] - x[1]).map(([col, v]) => ({ col, w: v / tot * 100 }));
        };
        const dayIso = sel || todayIso;
        const stepDay = (delta) => {
          const dt = new Date(dayIso + 'T12:00'); dt.setDate(dt.getDate() + delta);
          const iso = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
          const pos = dateToMonth(iso);
          if (!pos) return;
          setCalDay(iso);
          if (pos.yr !== selectedYear || pos.m !== selectedMonth) { setSelectedYear(pos.yr); setSelectedMonth(pos.m); }
        };
        const dayTotals = (o) => (
          <div className="flex flex-wrap gap-1.5 text-[12px] font-mono">
            {o.inc > 0 && <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-notion-green">+ {fmtCents(o.inc)}</span>}
            {o.out > 0 && <span className="px-2 py-0.5 rounded-full bg-subtle text-primary">− {fmtCents(o.out)}</span>}
            {o.due > 0 && <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">{t('calDue')} {fmtCents(o.due)}</span>}
          </div>
        );
        const dayList = (iso, o) => (
          <div key={iso} className="pop-in space-y-2">
            {o.list.length === 0 && <p className="text-[12px] text-tertiary py-2">{t('calDayEmpty')}</p>}
            {o.list.map(row)}
            <button onClick={() => { setB({ date: iso }); if (view !== 'book') setView('book'); else try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {} }}
              className="w-full py-2 rounded-xl border border-dashed border-strong text-[12px] text-notion-blue">{t('calAddHere')}</button>
          </div>
        );
        // A compact calendar widget: a small month on one side, the chosen day on the other.
        const dayIso2 = sel || todayIso;
        const dSel = new Date(dayIso2 + 'T12:00');
        const od = c.byDay[+dayIso2.slice(8, 10)] || { list: [], out: 0, inc: 0, due: 0, dueIn: 0 };
        const mini = (e) => (
          <div key={e.key} role="button" tabIndex={0} className={`cw-item ${e.planned ? 'cw-item-due' : ''}`}
            onClick={(ev) => { if (ev.target.closest('.cw-x')) return; if (e.txId) openEntry(e.txId); else if (e.cat && e.type !== 'transfer') showItem(e.type, e.cat); }}
            onKeyDown={(ev) => { if (ev.key === 'Enter') { if (e.txId) openEntry(e.txId); else if (e.cat && e.type !== 'transfer') showItem(e.type, e.cat); } }}>
            {e.type === 'transfer'
              ? <span className="cw-ico cw-ico-tr"><i className="fa-solid fa-right-left"></i></span>
              : <ItemIcon spec={iconFor(e.type, e.cat)} tint={tintFor(e.type, e.cat)} size={22} />}
            <span className="cw-name">{e.type === 'transfer' ? `${accName(e.from)} → ${accName(e.to)}` : e.cat}{e.planned ? <em> · {kindLabel(e)}</em> : null}</span>
            <span className={`cw-amt ${e.type === 'incomes' ? 'cw-pos' : ''}`}>{e.type === 'incomes' ? '+' : e.type === 'transfer' ? '' : '−'}{fmtCents(e.amount)}</span>
            {e.txId && <button onClick={() => deleteTx(e.txId)} aria-label={t('deleteCategoryBtn')} className="cw-x"><i className="fa-solid fa-xmark"></i></button>}
            {e.trId && <button onClick={() => deleteTransfer(e.trId)} aria-label={t('deleteCategoryBtn')} className="cw-x"><i className="fa-solid fa-xmark"></i></button>}
          </div>
        );
        const body = (
          <div className="cw-wrap">
            <div className="cw">
              <div className="cw-month">
                <div className="cw-head">
                  {weekdays.map((w, i) => <span key={i} className={i === 6 ? 'cw-sun' : ''}>{w}</span>)}
                </div>
                <div className="cw-grid">
                  {Array.from({ length: c.lead }, (_, i) => <span key={'b' + i}></span>)}
                  {Array.from({ length: c.days }, (_, i) => {
                    const dd = i + 1, iso = c.prefix + pad2(dd), o = c.byDay[dd];
                    const sunday = (c.lead + i) % 7 === 6;
                    const isToday = iso === todayIso, isSel = iso === dayIso2 && !isToday;
                    return (
                      <button key={iso} type="button" onClick={() => setCalDay(iso)} aria-pressed={iso === dayIso2}
                        title={o.list.map(e => `${e.type === 'incomes' ? '+' : '−'} ${e.cat || ''} ${fmtCents(e.amount)}`).join('\n') || undefined}
                        className={`cw-day ${sunday ? 'cw-sun' : ''} ${isToday ? 'cw-today' : ''} ${isSel ? 'cw-sel' : ''}`}>
                        <span className="cw-n">{dd}</span>
                        <span className="cw-dots">
                          {o.out > 0 && <i className="cw-d-paid"></i>}
                          {o.due > 0 && <i className="cw-d-due"></i>}
                          {(o.inc > 0 || o.dueIn > 0) && <i className="cw-d-in"></i>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="cw-daypane">
                <div className="cw-dayhead">
                  <div>
                    <div className="cw-date">{dSel.toLocaleDateString(loc, { day: 'numeric', month: 'short' }).toUpperCase()}</div>
                    <div className="cw-wd">{dSel.toLocaleDateString(loc, { weekday: 'long' })}</div>
                  </div>
                  <button type="button" className="cw-add" aria-label={t('calAddHere')} title={t('calAddHere')}
                    onClick={() => { setB({ date: dayIso2 }); if (view !== 'book') setView('book'); else try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {} }}>
                    <i className="fa-solid fa-plus"></i>
                  </button>
                </div>
                <div className="cw-list" key={dayIso2}>
                  {od.list.length === 0 ? <p className="cw-empty">{t('calNothingDay')}</p> : od.list.map(mini)}
                </div>
              </div>
            </div>
            <div className="cw-sum">
              <span><i className="cw-d-paid"></i>{t('calPaid')} <b>{fmt(c.out)}</b></span>
              <span><i className="cw-d-in"></i>{t('calGot')} <b>{fmt(c.inc)}</b></span>
              <span><i className="cw-d-due"></i>{t('calStillDue')} <b>{fmt(c.due)}</b></span>
            </div>
            {c.undated.length > 0 && (
              <details className="cw-undated">
                <summary>{t('calUndated', { n: c.undated.length, amount: fmt(c.undated.filter(e => e.type === 'expenses').reduce((s2, e) => s2 + e.amount, 0)) })}</summary>
                <div className="cw-list">{c.undated.map(mini)}</div>
                <p className="cw-empty">{t('calUndatedHint')}</p>
              </details>
            )}
          </div>
        );
        if (inMonth) return panel({ id: 'monthCal', icon: 'fa-calendar-days', title: t('calTitle'), defaultCollapsed: true, sub: `${t('calPaid')} ${fmt(c.out)} · ${t('calStillDue')} ${fmt(c.due)}` }, body);
        return <div className="min-w-0">{body}</div>;
      };

      const renderBook = () => {
        const loc = lang === 'en' ? 'en-US' : lang === 'ar' ? 'ar-SY-u-nu-latn' : 'de-DE';
        const type = bk.type;
        const items = (data.categories[type] || []).slice().sort((a, b) => (bkUsage[type + '|' + b] || 0) - (bkUsage[type + '|' + a] || 0) || a.localeCompare(b));
        const q = bk.q.trim().toLowerCase();
        const matchRank = (c) => { const n = c.toLowerCase(); return n === q ? 3 : n.startsWith(q) ? 2 : n.split(/[\s/()&-]+/).some(w => w.startsWith(q)) ? 1 : 0; };
        const kindOf = (c) => type === 'incomes'
          ? (getMeta('incomes', c).mode === 'fixed' || /fix/.test(getMeta('incomes', c).bracket || '') ? 'regular' : 'oneoff')
          : getMeta('expenses', c).oneTime ? 'onebill' : kindForGroup('expenses', getMeta('expenses', c).bracket);
        const curKind = bk.kind || (type === 'incomes' ? 'oneoff' : 'purchase');
        const filtered = q ? items.filter(c => c.toLowerCase().includes(q)).sort((a, b) => matchRank(b) - matchRank(a)) : items.filter(c => kindOf(c) === curKind);
        let shown = q || bk.all ? filtered : filtered.slice(0, 11);
        // An item picked from elsewhere (e.g. "+" in Month) is always visible and selected.
        if (bk.cat && bk.cat !== '__new' && !shown.includes(bk.cat) && items.includes(bk.cat)) shown = [bk.cat, ...shown.slice(0, 10)];
        const isoOf = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
        const yesterday = (() => { const dt = new Date(); dt.setDate(dt.getDate() - 1); return isoOf(dt); })();
        const chip = (on) => `px-3 py-1.5 rounded-full text-[12px] border transition ${on ? 'border-notion-blue bg-notion-blue/10 text-primary font-semibold' : 'border-subtle bg-subtle/60 text-secondary hover:text-primary'}`;
        const label = (txt) => <div className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">{txt}</div>;
        const amountOk = parseAmount(bk.amount) !== null;

        const todayIso = todayISO();

        return (
          <div className="grid grid-cols-1 gap-4 lg:gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
            <section className="min-w-0 rounded-2xl border border-subtle bg-surface p-4 space-y-4">
              <Segmented full options={[['expenses', t('bkOut')], ['incomes', t('bkIn')], ...(data.accounts.length > 1 ? [['transfer', t('bkTransfer')]] : [])]} value={type} onChange={(v) => setB({ type: v, cat: null, q: '', all: false, kind: v === 'incomes' ? 'oneoff' : 'purchase' })} />
              <div className={`flex items-baseline gap-2 rounded-2xl px-4 py-3 ${bk.err === 'amount' ? 'bg-red-500/10' : 'bg-subtle/60'}`}>
                <input data-free value={bk.amount} onChange={(e) => setB({ amount: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (type === 'transfer' ? saveTransfer() : saveBooking())}
                  inputMode="decimal" placeholder="0,00" aria-label={t('bkAmount')}
                  className={`flex-1 min-w-0 bg-transparent outline-none text-[38px] leading-none font-semibold font-mono ${type === 'incomes' ? 'text-notion-green' : 'text-primary'}`} />
                <span className="text-[22px] text-tertiary font-mono">€</span>
                {type === 'expenses' && (
                  <label className={`relative shrink-0 self-center w-11 h-11 rounded-xl flex items-center justify-center cursor-pointer transition active:scale-95 ${receiptBusy ? 'bg-notion-blue/20 text-notion-blue' : 'bg-surface text-secondary hover:text-primary border border-subtle'}`}
                    title={t('rcPhoto')} aria-label={t('rcPhoto')}>
                    <i className={`fa-solid ${receiptBusy ? 'fa-spinner fa-spin' : 'fa-camera'} text-[16px]`}></i>
                    <input data-free type="file" accept="image/*" capture="environment" disabled={receiptBusy} className="absolute inset-0 opacity-0 cursor-pointer"
                      onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; readReceiptPhoto(f); }} />
                  </label>
                )}
              </div>
              {type === 'expenses' && !bk.amount && <div className="-mt-2 text-[11px] text-tertiary">{receiptBusy ? t('rcBusy') : t('rcHint')}</div>}

              {(() => {
                // Repeat a recent entry with one tap (amount, item, account and person; the date stays).
                if (type === 'transfer') return null;
                const seen = new Set(), recent = [];
                [...(data.tx || [])].reverse().forEach(x => {
                  const k = x.type + '|' + x.cat + '|' + x.amount;
                  if (x.type !== type || seen.has(k) || recent.length >= 4 || !data.categories[x.type].includes(x.cat)) return;
                  seen.add(k); recent.push(x);
                });
                if (!recent.length) return null;
                return (
                  <div className="space-y-1.5">
                    {label(t('bkRepeat'))}
                    <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1" style={{ scrollbarWidth: 'none' }}>
                      {recent.map(x => (
                        <button key={x.id} type="button" onClick={() => setB({ amount: String(x.amount).replace('.', ','), cat: x.cat, account: x.account || '', who: x.who || bk.who, note: x.note || '' })}
                          className="shrink-0 flex items-center gap-2 ps-1.5 pe-3 py-1.5 rounded-2xl border border-subtle bg-subtle/50 hover:bg-subtle active:scale-95 transition">
                          <ItemIcon spec={iconFor(x.type, x.cat)} tint={tintFor(x.type, x.cat)} size={24} />
                          <span className="text-start leading-tight">
                            <span className="block text-[12px] text-primary max-w-[110px] truncate">{x.cat}</span>
                            <span className="block text-[11px] font-mono text-secondary">{fmtCents(x.amount)}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {type === 'transfer' && (() => {
                const pick = (key) => (
                  <div className="flex flex-wrap gap-1.5">
                    {data.accounts.map(a => (
                      <button key={a.id} type="button" onClick={() => setB({ [key]: a.id })} disabled={key === 'to' && bk.from === a.id}
                        className={`${chip(bk[key] === a.id)} disabled:opacity-30`}>
                        <i className={`fa-solid ${a.kind === 'cash' ? 'fa-money-bill-wave' : 'fa-building-columns'} text-[10px] me-1.5 opacity-60`}></i>{a.name}
                      </button>
                    ))}
                  </div>
                );
                return (
                  <div className={`space-y-3 ${bk.err === 'accounts' ? 'rounded-xl ring-2 ring-red-500/40 p-2' : ''}`}>
                    <div className="space-y-2">{label(t('trFrom'))}{pick('from')}</div>
                    <div className="flex justify-center text-tertiary"><i className="fa-solid fa-arrow-down"></i></div>
                    <div className="space-y-2">{label(t('trTo'))}{pick('to')}</div>
                    <label className="flex items-start gap-2.5 p-2.5 rounded-xl bg-subtle/60 cursor-pointer">
                      <input data-free type="checkbox" checked={bk.moveBal !== false} onChange={(e) => setB({ moveBal: e.target.checked })} className="mt-0.5 w-4 h-4" />
                      <span className="text-[12px] text-primary leading-snug">{t('trMove')}<span className="block text-[11px] text-tertiary">{t('trMoveHint')}</span></span>
                    </label>
                  </div>
                );
              })()}

              {type !== 'transfer' && (() => {
                const kinds = type === 'incomes'
                  ? [['oneoff', 'fa-coins', t('kOneoffIn')], ['regular', 'fa-repeat', t('kRegularIn')]]
                  : [['purchase', 'fa-bag-shopping', t('kPurchase')], ['bill', 'fa-file-invoice', t('kBill')], ['sub', 'fa-rotate', t('kSub')], ['onebill', 'fa-calendar-day', t('kOnebill')]];
                return (
                  <div className="space-y-2">
                    {label(t('kWhatKind'))}
                    <div className={`grid gap-1.5 ${kinds.length === 4 ? 'grid-cols-4' : 'grid-cols-2'}`}>
                      {kinds.map(([id, ic, lbl]) => (
                        <button key={id} type="button"
                          onClick={() => setB({ kind: id, newGroup: type === 'expenses' ? groupForKind(id) : bk.newGroup, paidNow: id !== 'onebill' || bk.date <= todayIso,
                            ...(bk.cat && bk.cat !== '__new' && kindOf(bk.cat) !== id ? { cat: null } : {}), all: false })}
                          className={`flex flex-col items-center gap-1 rounded-xl py-2 border transition active:scale-95 ${curKind === id ? 'border-notion-blue bg-notion-blue/10 text-primary' : 'border-subtle bg-subtle/50 text-secondary'}`}>
                          <i className={`fa-solid ${ic} text-[14px]`}></i>
                          <span className="text-[10.5px] leading-tight text-center font-medium">{lbl}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div className={`space-y-2 ${type === 'transfer' ? 'hidden' : ''}`}>
                {label(type === 'incomes' ? t('bkWhereIn') : t('bkWhere'))}
                {/* Big search field: full width, easy to reach with the thumb, with a clear button. */}
                <div className={`flex items-center gap-2.5 rounded-2xl border-2 px-3.5 transition-colors ${bk.q ? 'border-notion-blue bg-notion-blue/5' : 'border-subtle bg-subtle/60 focus-within:border-notion-blue'}`} style={{ height: 50 }}>
                  <i className={`fa-solid fa-magnifying-glass text-[15px] ${bk.q ? 'text-notion-blue' : 'text-tertiary'}`}></i>
                  <input data-free type="search" enterKeyHint="search" autoComplete="off" value={bk.q}
                    onChange={(e) => setB({ q: e.target.value, moreSugg: false })}
                    onFocus={(e) => { const el = e.currentTarget.parentElement; setTimeout(() => { try { const top = el.getBoundingClientRect().top + window.scrollY - 76; window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }); } catch (err) {} }, 250); }}
                    placeholder={t('bkSearchBig')}
                    className="flex-1 min-w-0 bg-transparent outline-none text-[16px] text-primary placeholder:text-tertiary" />
                  {bk.q && (
                    <button type="button" onClick={() => setB({ q: '', moreSugg: false })} aria-label={t('closeBtn')}
                      className="pop-in w-8 h-8 shrink-0 rounded-full bg-subtle text-secondary hover:text-primary flex items-center justify-center active:scale-90">
                      <i className="fa-solid fa-xmark text-[13px]"></i>
                    </button>
                  )}
                </div>
                {q && <div className="text-[11px] text-tertiary">{t('bkFound', { n: filtered.length })}</div>}
                <div className={`grid grid-cols-3 sm:grid-cols-4 gap-1.5 ${bk.err === 'cat' ? 'rounded-xl ring-2 ring-red-500/40 p-1' : ''}`}>
                  {shown.map(c => {
                    const on = bk.cat === c;
                    return (
                      <button key={c} type="button" onClick={() => { const n0 = dateToMonth(bk.date) ? getNode(type, c, dateToMonth(bk.date).yr, dateToMonth(bk.date).m) : null;
                        setB({ cat: c, shop: '', kind: kindOf(c), ...(n0 && n0.budget > 0 && !bk.amount && !isReceiptItem(c) ? { amount: String(n0.budget).replace('.', lang === 'en' ? '.' : ',') } : {}) }); }}
                        className={`flex flex-col items-center gap-1 rounded-xl px-1.5 py-2 border transition active:scale-95 ${on ? 'border-notion-blue bg-notion-blue/10' : 'border-transparent bg-subtle/50 hover:bg-subtle'}`}>
                        <ItemIcon spec={iconFor(type, c)} tint={tintFor(type, c)} size={30} />
                        <span className={`w-full text-center text-[11px] leading-tight truncate ${on ? 'text-primary font-semibold' : 'text-secondary'}`}>{c}</span>
                      </button>
                    );
                  })}
                  <button type="button" onClick={() => setB({ cat: '__new', newName: bk.q.trim() || bk.newName, kind: curKind, newGroup: type === 'expenses' ? groupForKind(curKind) : '', paidNow: curKind !== 'onebill' || bk.date <= todayIso })}
                    className={`flex flex-col items-center gap-1 rounded-xl px-1.5 py-2 border border-dashed transition ${bk.cat === '__new' ? 'border-notion-blue bg-notion-blue/10' : 'border-strong'}`}>
                    <span className="w-[30px] h-[30px] rounded-[9px] bg-subtle flex items-center justify-center text-secondary"><i className="fa-solid fa-plus text-xs"></i></span>
                    <span className="text-[11px] text-secondary">{t('bkNew')}</span>
                  </button>
                </div>
                {q.length >= 2 && (() => {
                  // Groups this household spends in most rank their suggestions higher.
                  const gUse = {};
                  data.categories.expenses.forEach(c => { const gid = getMeta('expenses', c).bracket; gUse[gid] = (gUse[gid] || 0) + (bkUsage['expenses|' + c] || 0); });
                  const score = (e) => {
                    const n = e[0].toLowerCase();
                    const m = n.startsWith(q) ? 30 : n.split(/[\s/()&-]+/).some(w => w.startsWith(q)) ? 20 : (e[3] || []).some(a => a.toLowerCase().startsWith(q)) ? 12 : 0;
                    // Everyday shopping (supermarkets, drugstores) is what people add most.
                    return m + Math.min(8, gUse[resolveGroup(data.groups, e[1]).id] || 0) + (e[1] === 'groceries' ? 4 : 0);
                  };
                  const all = merchantMatch(bk.q, data.categories[type] || [], type).sort((a, b) => score(b) - score(a) || MERCHANTS.indexOf(a) - MERCHANTS.indexOf(b));
                  // With your own items already matching, keep the extra ideas short.
                  const limit = bk.moreSugg ? 20 : filtered.length ? 3 : 6;
                  const sugg = all.slice(0, limit);
                  if (!sugg.length) return null;
                  return (
                    <div className="space-y-1.5 pop-in">
                      <div className="text-[11px] text-tertiary">{t('bkSuggest')}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {sugg.map(([name, gid, dom]) => {
                          const g = resolveGroup(data.groups, gid);
                          const spec = autoIcon(name) || (dom ? { kind: 'brand', text: name.slice(0, 2), bg: '#334155', fg: '#FFFFFF', logo: 'web:' + dom } : null) || { kind: 'symbol', icon: GROUP_ICONS[g.id] || 'fa-tag' };
                          const on = bk.cat === '__new' && bk.newName === name;
                          return (
                            <button key={name} type="button" onClick={() => { const k = kindForGroup(type, g.id); setB({ cat: '__new', newName: name, newGroup: g.id, kind: k, paidNow: k !== 'onebill' }); }}
                              className={`flex items-center gap-2 ps-1.5 pe-3 py-1 rounded-full border transition active:scale-95 ${on ? 'border-notion-blue bg-notion-blue/10' : 'border-subtle bg-subtle/50 hover:bg-subtle'}`}>
                              <ItemIcon spec={spec} tint={type === 'incomes' ? '#10b981' : GROUP_HEX[g.color] || '#64748b'} size={22} />
                              <span className="text-[12px] text-primary">{name}</span>
                              <span className="text-[10px] text-tertiary">{type === 'incomes' ? t('bkIn') : groupName(g)}</span>
                            </button>
                          );
                        })}
                        {all.length > sugg.length && (
                          <button type="button" onClick={() => setB({ moreSugg: true })} className="px-3 py-1 rounded-full text-[12px] text-notion-blue hover:underline">{t('bkMoreSugg', { n: all.length - sugg.length })}</button>
                        )}
                      </div>
                    </div>
                  );
                })()}
                {!q && filtered.length > 11 && (
                  <button onClick={() => setB({ all: !bk.all })} className="text-[12px] text-notion-blue hover:underline">{bk.all ? t('bkLess') : t('bkAll', { n: filtered.length })}</button>
                )}
                {bk.cat === '__new' && (() => {
                  const dir = MERCHANTS.find(e => e[0] === bk.newName);
                  if (!dir) return null;
                  const L = infoLang || lang;
                  const li = L === 'de' ? 0 : L === 'ar' ? 2 : 1;
                  const own = MERCHANT_INFO[dir[0]];
                  const gkey = dir[1].split('|')[0];
                  const text = own ? own[li] : (GROUP_INFO[gkey] || GROUP_INFO.oneoff)[li];
                  return (
                    <div className="pop-in rounded-xl border border-notion-blue/30 bg-notion-blue/5 p-3 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <i className="fa-solid fa-circle-info text-notion-blue text-[13px]"></i>
                        <span className="flex-1 text-[13px] font-semibold text-primary">{dir[0]}</span>
                        <div className="flex gap-0.5">
                          {[['ar', 'ع'], ['en', 'EN'], ['de', 'DE']].map(([k, l]) => (
                            <button key={k} type="button" onClick={() => setInfoLang(k)}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${L === k ? 'bg-notion-blue text-white' : 'text-tertiary hover:text-primary'}`}>{l}</button>
                          ))}
                        </div>
                      </div>
                      <p dir={L === 'ar' ? 'rtl' : 'ltr'} className={`text-[12.5px] leading-relaxed text-secondary ${L === 'ar' ? 'text-right' : 'text-left'}`}>{text}</p>
                      {dir[2] && <div className="text-[11px] text-tertiary"><i className="fa-solid fa-globe me-1"></i>{dir[2]}</div>}
                    </div>
                  );
                })()}
                {bk.cat === '__new' && (() => {
                  const kinds = type === 'incomes'
                    ? [['oneoff', 'fa-coins', t('kOneoffIn')], ['regular', 'fa-repeat', t('kRegularIn')]]
                    : [['purchase', 'fa-bag-shopping', t('kPurchase')], ['bill', 'fa-file-invoice', t('kBill')], ['sub', 'fa-rotate', t('kSub')], ['onebill', 'fa-calendar-day', t('kOnebill')]];
                  const k = bk.kind || kinds[0][0];
                  const planned = ['bill', 'sub', 'regular', 'onebill'].includes(k);
                  const due = parseInt(bk.payDay) || +bk.date.slice(8, 10);
                  return (
                    <div className="pop-in space-y-2.5">
                      {planned && (
                        <div className="rounded-xl bg-subtle/60 p-3 space-y-2.5">
                          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-primary">
                            {k === 'onebill' ? (
                              <span><i className="fa-regular fa-calendar me-1.5 text-secondary"></i>{t('kDueOn', { date: new Date(bk.date + 'T12:00').toLocaleDateString(loc, { day: 'numeric', month: 'long' }) })}</span>
                            ) : (<>
                              <span>{t('kEvery')}</span>
                              <select data-free value={bk.every || 1} onChange={(e) => setB({ every: +e.target.value })} className="bg-surface border border-subtle rounded-lg px-2 py-1 text-[12.5px]">
                                {[1, 2, 3, 6, 12].map(n => <option key={n} value={n}>{n === 1 ? t('kMonth1') : t('kMonthsN', { n })}</option>)}
                              </select>
                              <span>{type === 'incomes' ? t('kOnDayIn') : t('kOnDay')}</span>
                              <input data-free inputMode="numeric" value={bk.payDay || String(due)} onChange={(e) => setB({ payDay: e.target.value.replace(/\D/g, '').slice(0, 2) })}
                                style={{ width: 52 }} className="bg-surface border border-subtle rounded-lg px-2 py-1 text-center font-mono" />
                            </>)}
                          </div>
                          <label className="flex items-center justify-between gap-2 cursor-pointer">
                            <span className="text-[12.5px] text-primary">{type === 'incomes' ? t('kReceivedNow') : t('kPaidNow')}</span>
                            <input data-free type="checkbox" checked={bk.paidNow !== false} onChange={(e) => setB({ paidNow: e.target.checked })} className="w-4 h-4" />
                          </label>
                          <div className="text-[11px] text-tertiary leading-snug">
                            {k === 'onebill' ? (bk.paidNow !== false ? t('kHintOnebillPaid') : t('kHintOnebillLater'))
                              : bk.paidNow !== false ? t('kHintRepeatPaid', { every: bk.every > 1 ? t('kMonthsN', { n: bk.every }) : t('kMonth1') }) : t('kHintRepeatLater')}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {type !== 'transfer' && bk.cat && bk.cat !== '__new' && !isReceiptItem(bk.cat) && dateToMonth(bk.date) && (() => {
                  // An existing bill or regular income: what's planned this month and whether it's paid.
                  const pos = dateToMonth(bk.date);
                  const n0 = getNode(type, bk.cat, pos.yr, pos.m);
                  if (!(n0.budget > 0)) return null;
                  const pd = getMeta(type, bk.cat).payDay;
                  const paid = n0.actual >= n0.budget - 0.004;
                  return (
                    <div className={`pop-in flex items-center gap-2.5 rounded-xl px-3 py-2.5 border ${paid ? 'border-amber-500/40 bg-amber-500/10' : 'border-subtle bg-subtle/60'}`}>
                      <i className={`fa-solid ${paid ? 'fa-circle-exclamation text-amber-500' : 'fa-file-invoice text-secondary'} text-[14px]`}></i>
                      <span className="flex-1 min-w-0 text-[12.5px] text-primary leading-snug">
                        {t('kBillCard', { month: formatMonth(pos.m, lang), plan: fmtCents(n0.budget) })}{Number.isInteger(pd) ? ` · ${t('kDueDay', { d: pd })}` : ''}
                        {paid ? <span className="block text-[11px] text-amber-600 dark:text-amber-400">{t('kAlreadyPaid', { amount: fmtCents(n0.actual) })}</span>
                          : n0.actual > 0 ? <span className="block text-[11px] text-tertiary">{t('kPartPaid', { amount: fmtCents(n0.actual) })}</span> : null}
                      </span>
                      {!paid && parseAmount(bk.amount) !== n0.budget && (
                        <button type="button" onClick={() => setB({ amount: String(Math.max(0, n0.budget - n0.actual)).replace('.', lang === 'en' ? '.' : ',') })}
                          className="shrink-0 px-2.5 py-1 rounded-full bg-notion-blue text-white text-[11.5px] font-semibold">{fmtCents(Math.max(0, n0.budget - n0.actual))}</button>
                      )}
                    </div>
                  );
                })()}
                {bk.cat === '__new' && (
                  <div className="pop-in grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input data-free autoFocus value={bk.newName} onChange={(e) => setB({ newName: e.target.value })} placeholder={t('bkNewName')}
                      className="bg-subtle border border-subtle rounded-lg px-2.5 py-2 text-[13px] text-primary outline-none focus:border-strong" />
                    {type === 'expenses' && (
                      <select data-free value={bk.newGroup || (data.groups.find(g => g.kind === 'variable') || data.groups[0]).id} onChange={(e) => setB({ newGroup: e.target.value })}
                        className="bg-subtle border border-subtle rounded-lg px-2 py-2 text-[13px] text-primary">
                        {data.groups.map(g => <option key={g.id} value={g.id}>{groupName(g)}</option>)}
                      </select>
                    )}
                  </div>
                )}
                {type === 'expenses' && (() => {
                  // Shops that sell everything: ask what was bought, and keep the shop in the note.
                  const shopName = bk.shop || (bk.cat === '__new' ? (MULTI_SHOP_RE.test(bk.newName) ? bk.newName.trim() : '') : bk.cat && MULTI_SHOP_RE.test(bk.cat) ? bk.cat : '');
                  if (!shopName) return null;
                  if (bk.shop) {
                    if (bk.cat === '__new') return (
                      <div className="pop-in flex items-center gap-2 rounded-xl bg-notion-blue/10 border border-notion-blue/30 px-3 py-2 text-[12.5px]">
                        <ItemIcon spec={autoIcon(bk.shop) || { kind: 'symbol', icon: 'fa-store' }} size={22} />
                        <span className="flex-1 min-w-0 text-primary truncate">{t('shopBoughtAt', { shop: bk.shop, item: bk.newName || t('bkNew') })}</span>
                        <button type="button" onClick={() => setB({ shop: '' })} aria-label={t('closeBtn')} className="w-6 h-6 rounded-full text-tertiary hover:text-primary"><i className="fa-solid fa-xmark text-[11px]"></i></button>
                      </div>
                    );
                    return (
                      <div className="pop-in flex items-center gap-2 rounded-xl bg-notion-blue/10 border border-notion-blue/30 px-3 py-2 text-[12.5px]">
                        <ItemIcon spec={autoIcon(bk.shop) || { kind: 'symbol', icon: 'fa-store' }} size={22} />
                        <span className="flex-1 min-w-0 text-primary truncate">{t('shopBoughtAt', { shop: bk.shop, item: bk.cat })}</span>
                        <button type="button" onClick={() => setB({ shop: '' })} aria-label={t('closeBtn')} className="w-6 h-6 rounded-full text-tertiary hover:text-primary"><i className="fa-solid fa-xmark text-[11px]"></i></button>
                      </div>
                    );
                  }
                  // Things, not shops: no brand logo, no market/bakery, not a fixed bill.
                  const isShop = (c) => MULTI_SHOP_RE.test(c) || autoIcon(c)?.kind === 'brand' || /markt|market|bäcker|baecker|bakery|metzger|kiosk|apotheke|drogerie/i.test(c)
                    || MERCHANTS.some(e => e[0].toLowerCase() === c.toLowerCase() && e[1].startsWith('groceries'));
                  const things = data.categories.expenses
                    .filter(c => c !== bk.cat && !isShop(c) && data.groups.find(g => g.id === getMeta('expenses', c).bracket)?.kind !== 'fixed')
                    .sort((a2, b2) => (bkUsage['expenses|' + b2] || 0) - (bkUsage['expenses|' + a2] || 0));
                  const ideas = things.slice(0, 8);
                  return (
                    <div className="pop-in rounded-xl border border-notion-blue/30 bg-notion-blue/5 p-3 space-y-2">
                      <div className="text-[13px] font-semibold text-primary"><i className="fa-solid fa-bag-shopping text-notion-blue me-1.5"></i>{t('shopWhat', { shop: shopName })}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {ideas.map(c => (
                          <button key={c} type="button" onClick={() => setB({ cat: c, shop: shopName, newName: '' })}
                            className="flex items-center gap-1.5 ps-1 pe-2.5 py-1 rounded-full border border-subtle bg-surface hover:border-notion-blue active:scale-95 transition">
                            <ItemIcon spec={iconFor('expenses', c)} tint={tintFor('expenses', c)} size={22} />
                            <span className="text-[12px] text-primary">{c}</span>
                          </button>
                        ))}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <select data-free value="" onChange={(e) => { const v = e.target.value; if (v === '__new') setB({ cat: '__new', newName: '', shop: shopName }); else if (v) setB({ cat: v, shop: shopName, newName: '' }); }}
                          style={{ flex: '1 1 0', minWidth: 0, width: 'auto' }} className="bg-surface border border-subtle rounded-full px-3 py-1.5 text-[12px] text-primary">
                          <option value="">{t('shopAllItems')}</option>
                          {data.groups.map(g => {
                            const list = data.categories.expenses.filter(c => c !== bk.cat && getMeta('expenses', c).bracket === g.id);
                            return list.length ? <optgroup key={g.id} label={groupName(g)}>{list.map(c => <option key={c} value={c}>{c}</option>)}</optgroup> : null;
                          })}
                          <option value="__new">+ {t('shopNewItem')}</option>
                        </select>
                      </div>
                      <div className="text-[11px] text-tertiary">{t('shopKeep', { shop: shopName })}</div>
                    </div>
                  );
                })()}
              </div>

              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  {label(t('bkWhen'))}
                  <span className="text-[12px] font-medium text-primary">{new Date(bk.date + 'T12:00').toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                </div>
                {/* The last 7 days as tappable days, newest first; any other date through the calendar button. */}
                <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1" style={{ scrollbarWidth: 'none' }}>
                  {(() => {
                    const older = (() => { const dt = new Date(); dt.setDate(dt.getDate() - 6); return bk.date < isoOf(dt) || bk.date > todayIso; })();
                    return (
                      <label className={`relative shrink-0 w-[54px] rounded-xl py-1.5 flex flex-col items-center justify-center gap-0.5 border cursor-pointer transition active:scale-95 ${older ? 'border-notion-blue bg-notion-blue text-white' : 'border-dashed border-strong text-secondary'}`}>
                        <i className="fa-regular fa-calendar text-[14px]"></i>
                        <span className="text-[9.5px] leading-none">{older ? new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short' }).format(new Date(bk.date + 'T12:00')) : t('bkOther')}</span>
                        <input data-free type="date" value={bk.date} onChange={(e) => e.target.value && setB({ date: e.target.value })}
                          onClick={(e) => { try { e.currentTarget.showPicker(); } catch (err) {} }}
                          aria-label={t('bkOther')} className="absolute inset-0 opacity-0 cursor-pointer" />
                      </label>
                    );
                  })()}
                  {Array.from({ length: 7 }, (_, i) => {
                    const dt = new Date(); dt.setDate(dt.getDate() - i);
                    const iso = isoOf(dt), on = bk.date === iso;
                    return (
                      <button key={iso} type="button" onClick={() => setB({ date: iso })}
                        className={`shrink-0 w-[54px] rounded-xl py-1.5 flex flex-col items-center gap-0.5 border transition active:scale-95 ${on ? 'border-notion-blue bg-notion-blue text-white' : 'border-subtle bg-subtle/60 text-secondary hover:text-primary'}`}>
                        <span className="text-[9.5px] leading-none max-w-full truncate px-0.5">{i === 0 ? t('bkToday') : i === 1 ? t('bkYesterday') : new Intl.DateTimeFormat(loc, { weekday: 'short' }).format(dt)}</span>
                        <span className="text-[16px] leading-none font-semibold">{dt.getDate()}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {data.accounts.length > 0 && type !== 'transfer' && (
                <div className="space-y-2">
                  {label(t('bkAccount'))}
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => setB({ account: '' })} className={chip(!bk.account)}>{t('bkNoAccount')}</button>
                    {data.accounts.map(a => (
                      <button key={a.id} type="button" onClick={() => setB({ account: a.id })} className={chip(bk.account === a.id)}>
                        <i className={`fa-solid ${a.kind === 'cash' ? 'fa-money-bill-wave' : 'fa-building-columns'} text-[10px] me-1.5 opacity-60`}></i>{a.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {type === 'expenses' && bk.cat && (() => {
                const parts = bk.parts || [];
                const setPart = (i, patch) => setB({ parts: parts.map((p, j) => j === i ? { ...p, ...patch } : p) });
                const mainName = bk.cat === '__new' ? (bk.newName || t('bkNew')) : bk.cat;
                const total = parseAmount(bk.amount) || 0;
                const rest = Math.round((total - parts.reduce((a2, p) => a2 + (parseAmount(p.amount) || 0), 0)) * 100) / 100;
                if (!parts.length) return (
                  <button type="button" onClick={() => setB({ parts: [{ cat: '', amount: '' }] })} className="text-[12.5px] text-notion-blue font-medium hover:underline">
                    <i className="fa-solid fa-code-branch me-1.5 text-[11px]"></i>{t('splitBtn')}
                  </button>
                );
                return (
                  <div className={`pop-in rounded-xl bg-subtle/60 p-3 space-y-2 ${bk.err === 'split' ? 'ring-2 ring-red-500/40' : ''}`}>
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="font-semibold text-primary"><i className="fa-solid fa-code-branch me-1.5 text-[11px] text-secondary"></i>{t('splitTitle')}</span>
                      <button type="button" onClick={() => setB({ parts: [] })} className="text-tertiary hover:text-primary">{t('splitCancel')}</button>
                    </div>
                    <div className="flex items-center gap-2 text-[12.5px]">
                      <span className="flex-1 min-w-0 truncate text-primary">{mainName}</span>
                      <span className={`font-mono ${rest > 0 ? 'text-primary' : 'text-notion-red'}`}>{fmtCents(Math.max(0, rest))}</span>
                      <span className="text-[10px] text-tertiary w-12">{t('splitRest')}</span>
                    </div>
                    {parts.map((p, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <select data-free value={p.cat} onChange={(e) => setPart(i, { cat: e.target.value })} style={{ flex: '1 1 0', minWidth: 0, width: 'auto' }}
                          className="bg-surface border border-subtle rounded-lg px-2 py-1.5 text-[12.5px] text-primary">
                          <option value="">{t('mergePick')}</option>
                          {data.categories.expenses.filter(c => c !== bk.cat).map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <input data-free value={p.amount} onChange={(e) => setPart(i, { amount: e.target.value })} inputMode="decimal" placeholder="0,00" style={{ width: 88, flex: '0 0 88px' }}
                          className="bg-surface border border-subtle rounded-lg px-2 py-1.5 text-[12.5px] text-end font-mono text-primary outline-none focus:border-notion-blue" />
                        <button type="button" onClick={() => setB({ parts: parts.filter((_, j) => j !== i) })} aria-label={t('closeBtn')} className="w-6 h-6 shrink-0 rounded-full text-tertiary hover:text-notion-red"><i className="fa-solid fa-xmark text-[11px]"></i></button>
                      </div>
                    ))}
                    {parts.length < 4 && (
                      <button type="button" onClick={() => setB({ parts: [...parts, { cat: '', amount: '' }] })} className="text-[12px] text-notion-blue hover:underline">+ {t('splitAdd')}</button>
                    )}
                  </div>
                );
              })()}

              <div className={`space-y-2 ${type === 'transfer' ? 'hidden' : ''}`}>
                {label(t('bkWho'))}
                <div className="flex flex-wrap gap-1.5">
                  {WHO.map(w => <button key={w} type="button" onClick={() => setB({ who: w })} className={chip(bk.who === w)}>{whoLabel(w)}</button>)}
                </div>
              </div>

              <input data-free value={bk.note} onChange={(e) => setB({ note: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && saveBooking()} placeholder={t('bkNote')}
                className="w-full bg-subtle border border-subtle rounded-xl px-3 py-2.5 text-[13px] text-primary outline-none focus:border-strong" />

              {type === 'expenses' && bk.cat && bk.cat !== '__new' && dateToMonth(bk.date) && (() => {
                // What this purchase does to its budget, before saving.
                const pos = dateToMonth(bk.date);
                const meta = getMeta('expenses', bk.cat);
                const g = data.groups.find(x => x.id === meta.bracket);
                if (!g) return null;
                const add = parseAmount(bk.amount) || 0;
                let spent, plan, label2;
                if (isReceiptItem(bk.cat)) {
                  spent = data.categories.expenses.filter(c => getMeta('expenses', c).bracket === g.id && isReceiptItem(c)).reduce((sum, c) => sum + getNode('expenses', c, pos.yr, pos.m).actual, 0);
                  plan = getTarget(g.id, pos.yr, pos.m); label2 = groupName(g);
                } else {
                  const n = getNode('expenses', bk.cat, pos.yr, pos.m); spent = n.actual; plan = n.budget; label2 = bk.cat;
                }
                const after = spent + add, left = plan - after, over = plan > 0 && left < 0;
                return (
                  <div className="pop-in rounded-xl bg-subtle/60 px-3 py-2.5 space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2 text-[12px]">
                      <span className="text-secondary truncate">{label2} · {formatMonth(pos.m, lang)}</span>
                      <span className="font-mono text-primary shrink-0">{fmt(after)}{plan > 0 ? <span className="text-tertiary"> / {fmt(plan)}</span> : null}</span>
                    </div>
                    {plan > 0 && (
                      <div className="h-2 rounded-full bg-subtle overflow-hidden relative">
                        <div className="absolute inset-y-0 start-0 rounded-full" style={{ width: `${Math.min(100, spent / plan * 100)}%`, background: '#3b82f6' }}></div>
                        <div className="absolute inset-y-0 rounded-full transition-all" style={{ insetInlineStart: `${Math.min(100, spent / plan * 100)}%`, width: `${Math.max(0, Math.min(100, after / plan * 100) - Math.min(100, spent / plan * 100))}%`, background: over ? '#ef4444' : '#93c5fd' }}></div>
                      </div>
                    )}
                    <div className={`text-[11px] ${over ? 'text-notion-red font-medium' : 'text-tertiary'}`}>
                      {plan > 0 ? (over ? t('bkOver', { amount: fmt(-left) }) : t('bkLeft', { amount: fmt(left) })) : t('bkNoPlan')}
                    </div>
                  </div>
                );
              })()}
              {bk.err && <p className="text-[12px] text-notion-red">{t(bk.err === 'amount' ? 'bkNeedAmount' : bk.err === 'split' ? 'splitTooMuch' : bk.err === 'cat' ? 'bkNeedCat' : bk.err === 'accounts' ? 'trNeedAccounts' : 'bkNeedDate')}</p>}
              <button key={bk.saved} onClick={type === 'transfer' ? saveTransfer : saveBooking}
                style={{ height: 48 }} className={`w-full rounded-2xl text-[15px] font-semibold flex items-center justify-center gap-2 transition ${bk.saved ? 'saved-pulse' : ''} ${amountOk && (type === 'transfer' ? bk.from && bk.to && bk.from !== bk.to : bk.cat) ? 'bg-notion-blue text-white' : 'bg-subtle text-tertiary'}`}>
                <i className="fa-solid fa-check"></i>{t('bkSave')}{amountOk ? ` · ${fmtCents(parseAmount(bk.amount))}` : ''}
              </button>
            </section>

            {renderCalendar()}
          </div>
        );
      };

      const renderActivity = () => (
        <div className="space-y-4 max-w-3xl">
          <Segmented full options={[['entries', t('actEntries')], ['history', t('actHistory')], ['summary', t('actSummary')]]} value={activityTab} onChange={setActivityTab} />
          {activityTab === 'entries' && renderEntries(true)}
          {activityTab === 'history' && renderHistory(true)}
          {activityTab === 'summary' && renderSummary(true)}
        </div>
      );

      const renderPlan = () => (
        <div className="space-y-4">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                  <div className="p-3 rounded-2xl border border-subtle bg-surface-elevated">
                    <div className="text-secondary text-[11px]">⚖️ {t('annualNet')}</div>
                    <div className={`text-lg font-mono font-bold mt-1 ${currentMetrics.actualNet >= 0 ? 'text-notion-green dark:text-emerald-400' : 'text-notion-red'}`}>{fmt(currentMetrics.actualNet)}</div>
                    <span className="text-[10px] font-mono text-tertiary">{t('kpiIn')} {fmt(currentMetrics.actualIn)} · {t('kpiOut')} {fmt(currentMetrics.actualEx)}</span>
                  </div>
                  <div className="p-3 rounded-2xl border border-subtle bg-surface-elevated">
                    <div className="text-secondary text-[11px]">📈 {t('kpiProjectedNet')}</div>
                    <div className={`text-lg font-mono font-bold mt-1 ${currentMetrics.projectedNet >= 0 ? 'text-notion-blue' : 'text-notion-red'}`}>{fmt(currentMetrics.projectedNet)}</div>
                  </div>
                  <div className="p-3 rounded-2xl border border-subtle bg-surface-elevated">
                    <div className="text-secondary text-[11px]">💾 {t('annualSavingsRate')}</div>
                    <div className="text-lg font-mono font-bold mt-1 text-primary">{savingsRate === null ? '–' : `${Math.round(savingsRate * 100)} %`}</div>
                  </div>
                  <div className="p-3 rounded-2xl border border-subtle bg-surface-elevated">
                    <div className="text-secondary text-[11px]">🏦 {t('kpiCumulative')}</div>
                    <div className="text-lg font-mono font-bold mt-1 text-primary">{fmtBalance(currentMetrics.endProjectedBalance)}</div>
                  </div>
                </div>

                <div className="rounded-2xl border border-subtle bg-surface overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="text-secondary text-[10px] border-b border-subtle">
                        <th className="text-start font-medium px-3 py-2 font-sans">{t('annualMonth')}</th>
                        <th className="text-end font-medium px-2 py-2">{t('kpiIn')}</th>
                        <th className="text-end font-medium px-2 py-2">{t('kpiOut')}</th>
                        <th className="text-end font-medium px-2 py-2">{t('annualNet')}</th>
                        <th className="text-end font-medium px-2 py-2">{t('annualProjected')}</th>
                        <th className="text-end font-medium px-3 py-2">{t('annualBalance')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yearRows.map(r => {
                        const status = monthStatus(r.year, r.month);
                        return (
                          <tr
                            key={r.key}
                            onClick={() => { setSelectedMonth(r.month); setView('month'); }}
                            className={`border-b border-subtle last:border-0 cursor-pointer hover:bg-subtle/60 ${status === 'current' ? 'bg-subtle/40' : ''}`}
                          >
                            <td className={`px-3 py-1.5 font-sans ${status === 'future' ? 'text-secondary' : 'text-primary font-medium'}`}>
                              {formatMonth(r.month, lang)}{status === 'current' && ' •'}
                            </td>
                            <td className="text-end px-2 py-1.5 text-notion-green">{fmt(r.actualIn)}</td>
                            <td className="text-end px-2 py-1.5 text-notion-red">{fmt(r.actualEx)}</td>
                            <td className={`text-end px-2 py-1.5 ${r.actualNet >= 0 ? 'text-primary' : 'text-notion-red'}`}>{fmt(r.actualNet)}</td>
                            <td className={`text-end px-2 py-1.5 ${r.projectedNet >= 0 ? 'text-notion-blue' : 'text-notion-red'}`}>{fmt(r.projectedNet)}</td>
                            <td className={`text-end px-3 py-1.5 font-semibold ${r.endProjectedBalance == null ? 'text-tertiary' : r.endProjectedBalance >= 0 ? 'text-primary' : 'text-notion-red'}`}>{fmtBalance(r.endProjectedBalance)}</td>
                          </tr>
                        );
                      })}
                      <tr className="border-t border-strong font-semibold">
                        <td className="px-3 py-2 font-sans text-primary">{t('annualTotal')}</td>
                        <td className="text-end px-2 py-2 text-notion-green">{fmt(currentMetrics.actualIn)}</td>
                        <td className="text-end px-2 py-2 text-notion-red">{fmt(currentMetrics.actualEx)}</td>
                        <td className="text-end px-2 py-2 text-primary">{fmt(currentMetrics.actualNet)}</td>
                        <td className="text-end px-2 py-2 text-notion-blue">{fmt(currentMetrics.projectedNet)}</td>
                        <td className="text-end px-3 py-2 text-primary">{fmtBalance(currentMetrics.endProjectedBalance)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {yearReport && yearReport.groups.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-subtle bg-surface p-4 space-y-2">
                      <div className="text-[13px] font-semibold text-primary">{t('reportGroups', { year: selectedYear })}</div>
                      {yearReport.groups.map(x => (
                        <div key={x.g.id} className="space-y-0.5">
                          <div className="flex items-baseline justify-between gap-2 text-xs">
                            <span className="text-primary truncate">{groupName(x.g)}</span>
                            <span className="font-mono text-primary shrink-0">{fmt(x.total)} <span className="text-tertiary text-[10px]">· {t('perMonthShort', { amount: fmt(x.avg) })}</span></span>
                          </div>
                          <div className="h-1.5 rounded-full bg-subtle overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${x.total / yearReport.max * 100}%`, background: GROUP_HEX[x.g.color] }}></div>
                          </div>
                        </div>
                      ))}
                      <Hint label={t('showDetails')} text={t('reportAvgNote', { n: yearReport.activeMonths })} />
                    </div>
                    <div className="space-y-3">
                      <div className="rounded-2xl border border-subtle bg-surface p-4 space-y-1.5">
                        <div className="text-[13px] font-semibold text-primary">{t('reportTopItems')}</div>
                        {yearReport.items.map((x, i) => (
                          <div key={x.cat} className="flex items-baseline justify-between gap-2 text-xs">
                            <span className="text-primary truncate"><span className="text-tertiary font-mono me-1.5">{i + 1}</span>{x.cat}</span>
                            <span className="font-mono text-primary shrink-0">{fmt(x.total)}</span>
                          </div>
                        ))}
                      </div>
                      {yearReport.byWho.some(x => x.total > 0) && <div className="rounded-2xl border border-subtle bg-surface p-4 space-y-1.5">
                        <div className="text-[13px] font-semibold text-primary">{t('whoPaidTitle')}</div>
                        <div className="grid grid-cols-3 gap-1.5">
                          {yearReport.byWho.map(x => (
                            <div key={x.w} className="p-2 rounded bg-subtle">
                              <div className="text-[10px] text-secondary truncate">{whoLabel(x.w)}</div>
                              <div className="font-mono text-sm font-semibold text-primary">{fmt(x.total)}</div>
                            </div>
                          ))}
                        </div>
                        <Hint label={t('showDetails')} text={t('reportWhoNote')} />
                      </div>}
                    </div>
                  </div>
                )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 items-start">
            <div className="space-y-4 min-w-0">{renderForecast()}{renderIncomeEnd(false)}</div>
            <div className="space-y-4 min-w-0">
                          {setAsides.rows.length > 0 && (
                            <div className="rounded-2xl border border-subtle bg-surface p-4 space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-[13px] font-semibold text-primary">{t('setAsideTitle')}</span>
                                <span className="text-xs font-mono font-semibold text-primary">{t('perMonthShort', { amount: fmtCents(setAsides.total) })}</span>
                              </div>
                              <Hint label={t('showDetails')} text={t('setAsideHint')} />
                              {setAsides.rows.map(r => (
                                <div key={r.cat} className="flex items-center justify-between gap-2 text-xs">
                                  <div className="min-w-0">
                                    <div className="text-primary truncate">{r.cat}</div>
                                    <div className="text-[10px] text-tertiary">
                                      {fmtCents(r.amount)} · {r.kind === 'once' ? t('setAsideOnce', { month: monthLabel(r.next.yr, r.next.m) }) : t('setAsideRhythm', { n: r.count, month: monthLabel(r.next.yr, r.next.m) })}
                                    </div>
                                  </div>
                                  <span className="font-mono text-primary shrink-0">{t('perMonthShort', { amount: fmtCents(r.perMonth) })}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="rounded-2xl border border-subtle bg-surface p-4 space-y-2.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[13px] font-semibold text-primary">{t('goalsTitle')}</span>
                              <button onClick={() => setGoalModal({ id: null, name: '', target: '', saved: '', deadline: '' })} className="text-[11px] text-notion-blue hover:underline">
                                {t('goalNew')}
                              </button>
                            </div>
                            {data.goals.length === 0 && <p className="text-[11px] text-tertiary">{t('goalsEmpty')}</p>}
                            {data.goals.map(g => {
                              const left = Math.max(0, g.target - g.saved);
                              const months = monthsUntil(g.deadline);
                              const pct = g.target > 0 ? Math.min(100, g.saved / g.target * 100) : 0;
                              return (
                                <div key={g.id} className="space-y-1">
                                  <div className="flex items-baseline justify-between gap-2 text-xs">
                                    <button onClick={() => setGoalModal({ id: g.id, name: g.name, target: String(g.target), saved: String(g.saved), deadline: g.deadline || '' })}
                                      className="font-medium text-primary truncate text-start hover:underline">{g.name}</button>
                                    <span className="font-mono text-primary shrink-0">{fmt(g.saved)} <span className="text-tertiary">/ {fmt(g.target)}</span></span>
                                  </div>
                                  <div className="h-1.5 rounded-full bg-subtle overflow-hidden">
                                    <div className="h-full rounded-full bg-notion-green transition-all" style={{ width: `${pct}%` }}></div>
                                  </div>
                                  <div className="flex items-center justify-between gap-2 text-[10px] text-tertiary">
                                    <span>
                                      {left <= 0 ? t('goalReached')
                                        : months ? t('goalPerMonth', { amount: fmtCents(left / months), month: keyLabel(g.deadline) })
                                        : t('goalLeft', { amount: fmtCents(left) })}
                                    </span>
                                    {depositFor !== g.id && (
                                      <button onClick={() => { setDepositFor(g.id); setDepositAmount(''); }} className="text-notion-blue text-[11px] hover:underline">{t('goalDeposit')}</button>
                                    )}
                                  </div>
                                  {depositFor === g.id && (
                                    <form onSubmit={(e) => { e.preventDefault(); depositGoal(g.id); }} className="flex gap-1.5">
                                      <input autoFocus inputMode="decimal" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} placeholder="0,00 €"
                                        aria-label={t('goalDeposit')} className="flex-1 min-w-0 bg-subtle border border-strong rounded px-2 py-1 font-mono text-xs text-end text-primary outline-none" />
                                      <button type="submit" className="px-2.5 py-1 rounded bg-primary text-surface text-xs font-semibold">{t('addBtn')}</button>
                                      <button type="button" onClick={() => setDepositFor(null)} className="px-2 py-1 rounded bg-subtle text-secondary text-xs">{t('cancelBtn')}</button>
                                    </form>
                                  )}
                                </div>
                              );
                            })}
                          </div>

            </div>
          </div>
          {chartBox}
        </div>
      );

      const ACCOUNT_KINDS = [['main', 'accountMain'], ['gateway', 'accountGateway'], ['cash', 'accountCash'], ['savings', 'accountSavings']];
      const renderMore = () => (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 items-start">
          <div className="space-y-4 min-w-0">
            <div className="lg:hidden">{renderHealthLink()}</div>
            {panel({ id: 'accounts', icon: 'fa-building-columns', title: t('accountsTitle'), collapsible: false,
              sub: data.accounts.length ? `${t('accountsTotal')} ${fmtCents(accountsTotal)}${savingsTotal ? ` · ${t('accountSavings')} ${fmtCents(savingsTotal)}` : ''}` : null }, (
              <div className="space-y-3">
                <p className="text-[12px] text-secondary leading-relaxed">{t('accountsIntro')}</p>
                {data.accounts.length === 0 ? (
                  <button onClick={setupAccounts} className="h-9 px-4 rounded-lg bg-primary text-surface text-xs font-semibold">{t('accountsSetup')}</button>
                ) : (
                  <>
                    {ACCOUNT_KINDS.map(([kind, labelKey]) => {
                      const list = data.accounts.filter(a => a.kind === kind);
                      if (!list.length) return null;
                      return (
                        <div key={kind} className="space-y-1.5">
                          <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wide">{t(labelKey)}</div>
                          {kind === 'savings' && <p className="text-[11px] text-tertiary leading-snug">{t('savingsHint')}</p>}
                          {list.map(a => (<div key={a.id} className="space-y-0.5">
                            <div className="flex items-center gap-2 rounded-xl bg-subtle/60 ps-3 pe-1 py-1.5">
                              <input value={a.name} onChange={(e) => updateAccount(a.id, { name: e.target.value })} aria-label={t('accountName')}
                                className="flex-1 min-w-0 bg-transparent text-[13px] text-primary outline-none" />
                              {a.updated && <span className="hidden sm:inline text-[10px] text-tertiary shrink-0">{t('accountsUpdated', { day: fmtDay(a.updated) })}</span>}
                              <MoneyInput value={a.balance} hideZero={false}
                                onChange={(v) => updateAccount(a.id, { balance: Math.round((parseFloat(v) || 0) * 100) / 100, updated: todayISO() })}
                                className="w-28 shrink-0 bg-surface" aria-label={a.name} />
                              <button data-edit onClick={() => removeAccount(a.id)} aria-label={t('iouDelete')} className="w-7 h-7 shrink-0 rounded-full text-tertiary hover:text-notion-red">
                                <i className="fa-solid fa-xmark text-[11px]"></i>
                              </button>
                            </div>
                            {(() => {
                              const c = accountCheck.find(x => x.a.id === a.id);
                              if (!c || !c.since || !c.since.length) return null;
                              return (
                                <div className="flex items-center gap-2 ps-3 pe-2 text-[11px] text-tertiary">
                                  <span className="flex-1 min-w-0">{t('acctSince', { day: fmtDay(a.updated), n: c.since.length, delta: `${c.delta >= 0 ? '+' : '−'}${fmtCents(Math.abs(c.delta))}` })}</span>
                                  <button onClick={() => updateAccount(a.id, { balance: c.expected, updated: todayISO() })} className="shrink-0 text-notion-blue font-medium">{t('acctExpected', { amount: fmtCents(c.expected) })}</button>
                                </div>
                              );
                            })()}
                          </div>))}
                        </div>
                      );
                    })}
                    <div className="flex flex-wrap gap-1.5">
                      {ACCOUNT_KINDS.map(([kind, labelKey]) => (
                        <button key={kind} onClick={() => addAccount(kind)} className="h-7 px-2.5 rounded-full border border-dashed border-strong text-[11px] text-secondary hover:text-primary">+ {t(labelKey)}</button>
                      ))}
                    </div>
                    <div className="rounded-xl border border-subtle p-3 space-y-1.5 text-[13px]">
                      <div className="flex justify-between"><span className="text-secondary">{t('accountsTotal')}</span><span className="font-mono font-semibold text-primary">{fmtCents(accountsTotal)}</span></div>
                      {appNow !== null && (
                        <>
                          <div className="flex justify-between"><span className="text-secondary">{t('accountsAppNow')}</span><span className="font-mono text-primary">{fmtCents(appNow)}</span></div>
                          <div className="flex justify-between border-t border-subtle pt-1.5">
                            <span className="text-secondary">{t('accountsDiff')}</span>
                            {Math.abs(accountsTotal - appNow) < 0.01
                              ? <span className="text-notion-green font-medium">{t('accountsMatch')}</span>
                              : <span className={`font-mono font-semibold ${accountsTotal - appNow < 0 ? 'text-notion-red' : 'text-notion-green'}`}>{accountsTotal - appNow > 0 ? '+' : '−'} {fmtCents(Math.abs(accountsTotal - appNow))}</span>}
                          </div>
                        </>
                      )}
                    </div>
                    {appNow !== null && Math.abs(accountsTotal - appNow) >= 0.01 && (
                      <button onClick={useAccountsAsReal} className="h-9 px-4 rounded-lg bg-primary text-surface text-xs font-semibold">{t('accountsUse')}</button>
                    )}
                  </>
                )}
              </div>
            ))}

            {panel({ id: 'tidy', icon: 'fa-wand-sparkles', title: t('tidyTitle'), defaultCollapsed: !tidyMoves.length,
              sub: tidyMoves.length ? t('tidyIntro', { n: tidyMoves.length }) : t('tidyNone') }, (
              tidyMoves.length ? (
                <div className="space-y-2">
                  {tidyMoves.map(mv => (
                    <div key={mv.cat} className="flex items-center justify-between gap-2 text-[12px]">
                      <span className="text-primary truncate">{mv.cat}</span>
                      <span className="text-secondary shrink-0 flex items-center gap-1.5">
                        <i className="fa-solid fa-arrow-right text-[9px] text-tertiary rtl:rotate-180"></i>
                        <span className="w-2 h-2 rounded-sm" style={{ background: GROUP_HEX[mv.rule.color] }}></span>
                        {groupName(data.groups.find(g => g.id === mv.to) || { id: mv.to, name: null })}
                      </span>
                    </div>
                  ))}
                  <button onClick={applyTidy} className="mt-1 h-9 px-4 rounded-lg bg-primary text-surface text-xs font-semibold">{t('tidyApply')}</button>
                </div>
              ) : <p className="text-[12px] text-secondary">{t('tidyNone')}</p>
            ))}
          </div>

          <div className="space-y-4 min-w-0">
                  <div className="rounded-2xl border border-subtle bg-surface p-3.5 space-y-3">
                    <div className="flex items-center justify-between gap-2 border-b border-subtle pb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs">🤝</span>
                        <span className="text-[13px] font-semibold text-primary">{t('iouTitle')}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs font-mono">
                        {totalBorrowed > 0 && <span className="text-notion-red font-semibold">{t('iouDebts')} {fmt(totalBorrowed)}</span>}
                        {totalLent > 0 && <span className="text-notion-green font-semibold">{t('iouReceivables')} {fmt(totalLent)}</span>}
                      </div>
                    </div>

                    <button onClick={openNewLoan} className="w-full h-10 rounded-xl bg-primary text-surface text-[13px] font-semibold flex items-center justify-center gap-2">
                      <i className="fa-solid fa-plus text-xs"></i>{t('loanNewBtn')}
                    </button>
                    {activeIous.length === 0 && <p className="text-[12px] text-tertiary">{t('loanNoneOpen')}</p>}
                    {(() => {
                      // Settled (and paid-off) loans: kept for history, and so duplicates can be removed.
                      const done = (data.ious || []).filter(i => !activeIous.includes(i));
                      if (!done.length) return null;
                      const key = (i) => `${(i.person || '').trim().toLowerCase()}|${parseFloat(i.amount) || 0}|${i.type}`;
                      const count = {}; (data.ious || []).forEach(i => { count[key(i)] = (count[key(i)] || 0) + 1; });
                      return (
                        <details className="rounded-xl bg-subtle/50 px-3 py-2 group">
                          <summary className="cursor-pointer text-[12.5px] text-secondary font-medium list-none flex items-center gap-2">
                            <i className="fa-solid fa-chevron-down text-[10px] transition-transform group-open:rotate-180"></i>{t('loanSettledList', { n: done.length })}
                          </summary>
                          <div className="pt-2 space-y-1.5">
                            {done.map(item => {
                              const back = item.repayCat ? repayItemOf(item) : null;
                              const dup = count[key(item)] > 1;
                              // Of two copies, the one without a link and without money is the spare one.
                              const spare = dup && !item.repayCat && !(item.booked && item.booked.cat);
                              return (
                                <div key={item.id} className={`flex items-center gap-2 rounded-lg px-2.5 py-2 ${spare ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-surface'}`}>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[12.5px] text-primary truncate">
                                      {item.person} · <span className="font-mono">{fmtCents(parseFloat(item.amount) || 0)}</span>
                                      <span className="text-tertiary"> · {item.type === 'borrowed' ? t('loanBorrowed') : t('loanLent')}</span>
                                    </div>
                                    <div className="text-[11px] text-tertiary leading-snug">
                                      {item.date}{back ? ` · ${t('loanPaidVia', { item: back, amount: fmtCents(repaidOf(item)) })}` : ` · ${t('loanNoLink')}`}
                                      {dup && <span className="text-amber-600 dark:text-amber-400 font-medium"> · {spare ? t('loanDupSpare') : t('loanDup')}</span>}
                                    </div>
                                  </div>
                                  {item.settled && (
                                    <button onClick={() => mutate(d => { const x = d.ious.find(i => i.id === item.id); if (x) x.settled = false; })}
                                      className="px-2 py-1 rounded-md text-[11px] bg-subtle text-secondary hover:text-primary">{t('loanReopen')}</button>
                                  )}
                                  <button onClick={() => handleDeleteIou(item)} aria-label={t('iouDelete')} title={t('iouDelete')}
                                    className="w-7 h-7 rounded-md bg-subtle text-secondary hover:text-notion-red"><i className="fa-solid fa-trash-can text-[11px]"></i></button>
                                </div>
                              );
                            })}
                          </div>
                        </details>
                      );
                    })()}

                    {activeIous.length > 0 && (
                      <div className="grid grid-cols-1 gap-2 pt-1">
                        {activeIous.map(item => {
                          const isBorrowed = item.type === 'borrowed';
                          const repayCat = repayItemOf(item);
                          const repaid = repaidOf(item);
                          const total = parseFloat(item.amount) || 0;
                          return (
                            <div key={item.id} className="p-2.5 rounded border border-subtle bg-surface-elevated space-y-1.5 text-xs">
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="font-semibold text-primary">{item.person}</div>
                                <div className="text-[10px] text-tertiary">
                                  {item.date} · <span className={isBorrowed ? 'text-notion-red' : 'text-notion-green'}>{isBorrowed ? t('iouIOweBadge') : t('iouOwedToMeBadge')}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`font-mono font-semibold ${isBorrowed ? 'text-notion-red' : 'text-notion-green'}`}>
                                  {fmt(item.amount)}
                                </span>
                                <button
                                  onClick={() => { setLoanAddPos(''); setLoanBookPos(''); setLoanEdit(item.id); }}
                                  className="px-2 py-0.5 rounded text-[10px] bg-subtle text-secondary hover:text-primary border border-subtle"
                                  title={t('loanEditTitle')}
                                  aria-label={t('loanEditTitle')}
                                >
                                  ✎
                                </button>
                                <button data-edit
                                  onClick={() => handleSettleIou(item.id)}
                                  className="px-2 py-0.5 rounded text-[10px] bg-subtle hover:bg-emerald-500/10 text-secondary hover:text-emerald-500 border border-subtle"
                                  title={t('iouMarkReturned')}
                                  aria-label={t('iouMarkReturned')}
                                >
                                  ✓
                                </button>
                                <button data-edit
                                  onClick={() => handleDeleteIou(item)}
                                  className="px-2 py-0.5 rounded text-[10px] bg-subtle hover:bg-rose-500/10 text-secondary hover:text-notion-red border border-subtle"
                                  title={t('iouDelete')}
                                  aria-label={t('iouDelete')}
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                            {(loanMoneyState(item) === 'unknown' || loanMoneyState(item) === 'off') && (
                              <button onClick={() => { setLoanAddPos(''); setLoanBookPos(''); setLoanEdit(item.id); }}
                                className="w-full text-start rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                                <i className="fa-solid fa-triangle-exclamation me-1.5"></i>
                                {t(loanMoneyState(item) === 'off' ? 'loanListNotCounted' : 'loanListCheck', { kind: t(isBorrowed ? 'loanAsIncome' : 'loanAsExpense') })}
                              </button>
                            )}
                            {isBorrowed && (repayCat ? (
                              <div className="space-y-1">
                                <div className="h-1.5 rounded-full bg-subtle overflow-hidden">
                                  <div className="h-full rounded-full bg-notion-green" style={{ width: `${total > 0 ? Math.min(100, repaid / total * 100) : 0}%` }}></div>
                                </div>
                                <div className="text-[10px] text-tertiary">{t('iouRepaid', { repaid: fmt(repaid), total: fmt(total), item: repayCat })}</div>
                              </div>
                            ) : (
                              <select
                                value=""
                                onChange={(e) => { const v = e.target.value; if (v) mutate(d => { const x = d.ious.find(i => i.id === item.id); if (x) x.repayCat = v; }); }}
                                className="w-full bg-subtle border border-subtle rounded px-2 py-1 text-[11px] text-secondary"
                              >
                                <option value="">{t('iouLinkRepay')}</option>
                                {data.categories.expenses.map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                            ))}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

            {panel({ id: 'tools', icon: 'fa-toolbox', title: t('toolsTitle'), collapsible: false }, (
              <div className="-mx-1">
                <div className="flex items-center gap-3 px-1 py-2">
                  <span className="w-8 h-8 rounded-lg bg-subtle flex items-center justify-center text-secondary"><i className="fa-solid fa-language text-xs"></i></span>
                  <Segmented size="sm" options={[['de', 'Deutsch'], ['en', 'English'], ['ar', 'العربية']]} value={lang} onChange={changeLanguage} />
                </div>
                {[
                  ['fa-wand-magic-sparkles', t('askTitle'), () => { setAskError(''); setAskModal(true); }],
                  ['fa-icons', iconBusy ? t('askThinking') : `${t('iconsAiTool')}${unmatchedItems().length ? ` (${unmatchedItems().length})` : ''}`, () => suggestIcons(unmatchedItems())],
                  ['fa-file-import', t('importTitle'), openImport],
                  ['fa-folder-plus', t('toolGroups'), () => openGroupModal()],
                  ['fa-gear', t('toolSettings'), () => setIsBurgerOpen(true)]
                ].map(([icon, label, fn]) => (
                  <button key={label} onClick={fn} className="w-full flex items-center gap-3 px-1 py-2 text-start hover:bg-subtle/60 rounded-xl">
                    <span className="w-8 h-8 rounded-lg bg-subtle flex items-center justify-center text-secondary"><i className={`fa-solid ${icon} text-xs`}></i></span>
                    <span className="flex-1 text-[13px] text-primary">{label}</span>
                    <i className="fa-solid fa-chevron-right text-[10px] text-tertiary rtl:rotate-180"></i>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      );

      return (
        <div className="min-h-screen font-sans">
          {/* SIDEBAR (laptop) */}
          <aside className="hidden lg:flex fixed inset-y-0 start-0 w-[232px] flex-col border-e border-subtle bg-surface z-40">
            <div className="h-16 px-5 flex items-center gap-2.5">
              <img src="icon-192.png" alt="" className="w-8 h-8 rounded-lg" />
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-primary truncate">{data.name || t('title')}</div>
                <div className={`text-[11px] truncate ${syncStatus === 'error' ? 'text-notion-red' : 'text-tertiary'}`}>{syncLabel}</div>
              </div>
            </div>
            <nav className="px-3 space-y-0.5">
              {NAV.map(([id, icon, label]) => (
                <button key={id} onClick={() => setView(id)} aria-current={view === id ? 'page' : undefined}
                  className={`w-full h-9 px-3 rounded-lg flex items-center gap-3 text-[13px] transition ${view === id ? 'bg-subtle text-primary font-semibold' : 'text-secondary hover:text-primary hover:bg-subtle/60'}`}>
                  <i className={`fa-solid ${icon} w-4 text-center text-[13px]`}></i><span>{label}</span>
                </button>
              ))}
            </nav>
            <div className="mt-auto p-3 flex items-center gap-1 border-t border-subtle">
              <button onClick={() => setIsBurgerOpen(true)} title={syncLabel} aria-label={syncLabel} className={`w-9 h-9 rounded-lg hover:bg-subtle ${syncColor}`}><i className={`fa-solid ${syncIcon} text-xs`}></i></button>
              <button onClick={() => changeLanguage({ de: 'en', en: 'ar', ar: 'de' }[lang])} title="Deutsch · English · العربية" className="h-9 px-2.5 rounded-lg hover:bg-subtle text-[12px] font-semibold text-secondary">{lang.toUpperCase()}</button>
              <button onClick={() => setIsBurgerOpen(true)} aria-label={t('options')} className="ms-auto w-9 h-9 rounded-lg hover:bg-subtle text-secondary"><i className="fa-solid fa-gear text-xs"></i></button>
            </div>
          </aside>

          <div className="lg:ps-[232px]">
            {/* TOP BAR */}
            <header className={`oneui-bar sticky top-0 z-30 transition-colors ${scrolled ? 'is-scrolled' : ''}`} style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
              <div className="max-w-[1280px] mx-auto h-14 px-4 lg:px-8 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h1 className={`oneui-smalltitle select-none text-[17px] font-semibold text-primary lg:text-[20px] tracking-tight truncate ${scrolled ? 'is-on' : ''}`}>{viewTitle}</h1>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {showMonthNav && monthNav}
                  {view === 'plan' && <Segmented size="sm" options={YEARS.map(y => [y, String(y)])} value={selectedYear} onChange={selectYear} />}
                  <button onClick={() => setSearch({ q: '', yr: 'all' })} aria-label={t('srchTitle')} title={t('srchTitle')} className="w-8 h-8 rounded-full hover:bg-subtle text-secondary">
                    <i className="fa-solid fa-magnifying-glass text-xs"></i>
                  </button>
                  <button onClick={() => setIsBurgerOpen(true)} aria-label={syncLabel} title={syncLabel} className={`lg:hidden w-8 h-8 rounded-full hover:bg-subtle ${syncColor}`}>
                    <i className={`fa-solid ${syncIcon} text-xs`}></i>
                  </button>
                </div>
              </div>
            </header>

            <main key={view + (showMonthNav ? `|${curIdx}` : '')}
              className={`${anim === 'next' ? 'slide-next' : anim === 'prev' ? 'slide-prev' : 'view-enter'} max-w-[1280px] mx-auto px-4 lg:px-8 pt-4 lg:pt-6 pb-36 lg:pb-12`}
              onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
              style={view === 'month' ? { touchAction: 'pan-y' } : undefined}>
              <div className="oneui-hero lg:hidden" aria-hidden={scrolled}>
                <div className="oneui-hero-title">{viewTitle}</div>
                <div className="oneui-hero-sub">{heroSub}</div>
              </div>
              {view === 'overview' && MB && renderOverview()}
              {view === 'month' && MB && renderMonth()}
              {view === 'book' && renderBook()}
              {view === 'activity' && renderActivity()}
              {view === 'plan' && renderPlan()}
              {view === 'health' && renderHealthView()}
              {view === 'more' && renderMore()}
            </main>
          </div>

          {/* TAB BAR (phone) */}
          <nav className="oneui-tabs lg:hidden fixed inset-x-0 z-40" style={{ bottom: 'calc(10px + env(safe-area-inset-bottom, 0px))' }}>
            <div className="oneui-tabs-in grid grid-cols-5 h-16">
              {NAV.filter(([id]) => id !== 'health' && id !== 'activity').map(([id, icon, label]) => id === 'book' ? (
                <button key={id} onClick={() => setView(id)} aria-current={view === id ? 'page' : undefined}
                  className="relative flex flex-col items-center justify-center gap-1 text-[10px] font-medium text-primary">
                  <span className={`w-12 h-12 -mt-5 rounded-full flex items-center justify-center shadow-lg transition-transform active:scale-95 ${view === id ? 'bg-notion-blue text-white' : 'bg-primary text-surface'}`}>
                    <i className="fa-solid fa-plus text-[18px]"></i>
                  </span>
                  <span>{label}</span>
                </button>
              ) : (
                <button key={id} onClick={() => setView(id)} aria-current={view === id ? 'page' : undefined}
                  className={`relative flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition ${view === id ? 'text-primary' : 'text-tertiary hover:text-secondary'}`}>
                  <span className={`absolute top-0 h-[3px] w-8 rounded-b-full bg-notion-blue transition-transform duration-200 ${view === id ? 'scale-x-100' : 'scale-x-0'}`}></span>
                  <span className={`w-12 h-7 rounded-full flex items-center justify-center transition-colors duration-200 ${view === id ? 'bg-subtle' : ''}`}>
                    <i className={`fa-solid ${icon} text-[16px]`}></i>
                  </span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </nav>

          <datalist id="merchant-list">{MERCHANTS.map(([n]) => <option key={n} value={n} />)}</datalist>
          {toastMsg && (
            <div
              role="status"
              className="fixed z-[60] left-1/2 -translate-x-1/2 bg-primary text-surface text-xs rounded-lg ps-3.5 pe-2 py-2 shadow-lg max-w-[calc(100%-32px)] flex items-center gap-3"
              style={{ bottom: 'calc(150px + env(safe-area-inset-bottom, 0px))' }}
            >
              <span className="py-0.5">{toastMsg.text}</span>
              {toastMsg.undo && (
                <button onClick={handleUndo} className="shrink-0 px-2 py-1 rounded font-semibold underline underline-offset-2">
                  {t('undoBtn')}
                </button>
              )}
            </div>
          )}

          {/* SAVINGS GOAL DIALOG */}
          {goalModal && (
            <Modal onClose={() => setGoalModal(null)} title={<><span>🎯</span><span>{goalModal.id ? t('goalEdit') : t('goalNewTitle')}</span></>}>
              <div>
                <label className="text-[10px] text-secondary font-medium block mb-1">{t('groupNameLabel')}</label>
                <input autoFocus value={goalModal.name} onChange={(e) => setGoalModal(g => ({ ...g, name: e.target.value }))} placeholder={t('goalNamePlaceholder')}
                  className="w-full bg-subtle border border-subtle rounded px-2.5 py-1.5 text-primary outline-none focus:border-strong font-medium" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-secondary font-medium block mb-1">{t('goalTarget')}</label>
                  <MoneyInput value={goalModal.target} onChange={(v) => setGoalModal(g => ({ ...g, target: v }))} className="py-1.5" />
                </div>
                <div>
                  <label className="text-[10px] text-secondary font-medium block mb-1">{t('goalSaved')}</label>
                  <MoneyInput value={goalModal.saved} onChange={(v) => setGoalModal(g => ({ ...g, saved: v }))} className="py-1.5" />
                </div>
              </div>
              <div>
                <label className="text-[10px] text-secondary font-medium block mb-1">{t('goalDeadline')}</label>
                <select value={goalModal.deadline} onChange={(e) => setGoalModal(g => ({ ...g, deadline: e.target.value }))}
                  className="w-full bg-subtle border border-subtle rounded px-2 py-1.5 text-xs text-primary outline-none">
                  <option value="">{t('goalNoDeadline')}</option>
                  {TIMELINE.map(({ yr, m }) => <option key={timelineKey(yr, m)} value={timelineKey(yr, m)}>{formatMonth(m, lang)} {yr}</option>)}
                </select>
              </div>
              <p className="text-[10px] text-tertiary">{t('goalHint')}</p>
              <div className="flex gap-2 pt-2 border-t border-subtle">
                {goalModal.id && (
                  <button
                    onClick={() => {
                      if (!confirm(t('goalDeleteConfirm', { name: goalModal.name }))) return;
                      mutate(d => { d.goals = d.goals.filter(x => x.id !== goalModal.id); });
                      setGoalModal(null);
                    }}
                    className="px-3 py-1.5 rounded bg-rose-500/10 border border-rose-500/20 text-notion-red"
                  >🗑</button>
                )}
                <button onClick={() => setGoalModal(null)} className="flex-1 py-1.5 bg-subtle text-secondary rounded hover:text-primary">{t('cancelBtn')}</button>
                <button onClick={saveGoal} disabled={!goalModal.name.trim() || parseAmount(goalModal.target) === null}
                  className="flex-1 py-1.5 bg-primary text-surface font-semibold rounded disabled:opacity-40">{t('groupSave')}</button>
              </div>
            </Modal>
          )}

          {/* BANK IMPORT */}
          {importModal && (() => {
            const m = importModal;
            const close = () => setImportModal(null);
            if (m.step === 'pick') {
              return (
                <Modal size="max-w-lg" onClose={close} title={<><span>⬇</span><span>{t('importTitle')}</span></>}>
                  <div>
                    <div className="text-[10px] text-secondary font-medium mb-1">{t('importAccount')}</div>
                    <div className="grid grid-cols-3 gap-1 bg-subtle p-0.5 rounded border border-subtle">
                      {WHO.map(w => (
                        <button
                          key={w}
                          type="button"
                          aria-pressed={m.account === w}
                          onClick={() => setImportModal(x => ({ ...x, account: w }))}
                          className={`py-1.5 rounded text-[11px] ${m.account === w ? 'bg-surface text-primary font-semibold shadow-sm' : 'text-secondary'}`}
                        >
                          {w === 'joint' ? t('importJoint') : t('importOwn', { name: whoLabel(w) })}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-secondary font-medium block mb-1">{t('importFrom')}</label>
                    <input
                      type="date"
                      value={m.fromDate}
                      onChange={(e) => setImportModal(x => ({ ...x, fromDate: e.target.value }))}
                      className="bg-subtle border border-subtle rounded px-2 py-1 text-xs text-primary"
                    />
                    <p className="text-[10px] text-tertiary mt-1">{t('importFromHint')}</p>
                  </div>
                  <label className="block p-4 rounded-lg border-2 border-dashed border-strong text-center cursor-pointer hover:border-primary text-primary font-medium">
                    <input
                      type="file"
                      accept=".csv,.xlsx,.xls,.pdf,text/csv,application/pdf"
                      className="hidden"
                      onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; handleStatementFile(f); }}
                    />
                    📄 {t('importChoose')}
                  </label>
                  {m.error && <p className="text-[11px] text-notion-red">{m.error}</p>}
                  <p className="text-[11px] text-secondary leading-relaxed p-2 rounded bg-subtle/60">{t('importHowTo')}</p>
                </Modal>
              );
            }
            const rows = m.rows;
            const open = rows.filter(r => !r.skip);
            const skipped = rows.filter(r => r.skip);
            const chosen = open.filter(r => r.include && r.target);
            const dup = skipped.filter(r => r.skip === 'dup').length;
            const transfers = open.filter(r => r.ownTransfer).length;
            const directionOf = (r) => r.amount > 0 && !/REFUND|ERSTATTUNG|RÜCKERSTATTUNG/.test(r.kind) ? 'incomes' : 'expenses';
            return (
              <Modal size="max-w-2xl" onClose={close} title={<><span>⬇</span><span>{t('importTitle')}</span></>}>
                <p className="text-[11px] text-secondary">
                  {t('importSummary', { file: m.fileName, n: rows.length, ready: chosen.length, dup, skipped: skipped.length - dup })}
                </p>
                {transfers > 0 && <p className="text-[11px] text-notion-blue">{t('importTransfersNote', { n: transfers })}</p>}
                {(() => {
                  // Typed-in entries this statement confirms, whose "who" or account differ from it.
                  const fixes = m.rows.filter(r => r.matchId).map(r => ({ r, x: data.tx.find(x => x.id === r.matchId) }))
                    .filter(({ r, x }) => x && (x.who !== r.who || (r.fixAcct && x.account !== r.fixAcct)));
                  if (!fixes.length) return null;
                  const on = fixes.filter(f => f.r.fix);
                  const acctName = (id) => data.accounts.find(a => a.id === id)?.name || '—';
                  return (
                    <div className="rounded-xl border border-notion-blue/30 bg-notion-blue/5 p-3 space-y-2">
                      <div className="text-[12.5px] font-semibold text-primary"><i className="fa-solid fa-user-pen me-1.5 text-notion-blue"></i>{t('fixTitle', { n: fixes.length })}</div>
                      <p className="text-[11px] text-secondary">{t('fixHint')}</p>
                      <div className="max-h-56 overflow-y-auto space-y-1">
                        {fixes.map(({ r, x }) => (
                          <label key={r.i} className="flex items-start gap-2 rounded-lg bg-surface px-2 py-1.5 cursor-pointer">
                            <input type="checkbox" checked={!!r.fix} onChange={(e) => setImportRow(r.i, { fix: e.target.checked })} className="mt-0.5 w-4 h-4" />
                            <span className="flex-1 min-w-0 text-[11.5px] leading-snug">
                              <span className="text-primary">{fmtDay(x.date)} · {x.cat} · {fmtCents(x.amount)}</span>
                              <span className="block text-tertiary">{whoLabel(x.who) || '—'} · {acctName(x.account)} <span className="text-notion-blue">→ {whoLabel(r.who)} · {acctName(r.fixAcct || x.account)}</span></span>
                            </span>
                          </label>
                        ))}
                      </div>
                      <button disabled={!on.length} onClick={() => {
                          mutateWithUndo(d => on.forEach(({ r }) => { const x = d.tx.find(y => y.id === r.matchId); if (x) { x.who = r.who; if (r.fixAcct) x.account = r.fixAcct; } }), t('fixDone', { n: on.length }));
                          setImportModal(mm => ({ ...mm, rows: mm.rows.map(r => r.matchId ? { ...r, fix: false, matchId: null } : r) }));
                        }}
                        className="w-full py-2 rounded-lg bg-notion-blue text-white text-[12.5px] font-semibold disabled:opacity-40">{t('fixBtn', { n: on.length })}</button>
                    </div>
                  );
                })()}
                {chosen.length > 0 && (() => {
                  const inSum = chosen.filter(r => directionOf(r) === 'incomes').reduce((a, r) => a + Math.abs(r.amount), 0);
                  const outSum = chosen.filter(r => directionOf(r) === 'expenses').reduce((a, r) => a + Math.abs(r.amount) + Math.abs(r.fee || 0), 0);
                  return <p className="text-[11px] font-mono text-primary">{t('importTotals', { inSum: fmtCents(inSum), outSum: fmtCents(outSum), net: fmtCents(inSum - outSum) })}</p>;
                })()}
                <div className="flex gap-3 text-[11px]">
                  <button onClick={() => setImportModal(x => ({ ...x, rows: x.rows.map(r => ({ ...r, include: !r.skip && !r.ownTransfer && !!r.target })) }))} className="text-notion-blue hover:underline">
                    {t('importSelectAll')}
                  </button>
                  <button onClick={() => setImportModal(x => ({ ...x, rows: x.rows.map(r => ({ ...r, include: false })) }))} className="text-notion-blue hover:underline">
                    {t('importSelectNone')}
                  </button>
                </div>
                <div className="max-h-[55vh] overflow-y-auto border border-subtle rounded divide-y divide-subtle">
                  {open.length === 0 && <p className="p-3 text-[11px] text-tertiary">{t('importNothingNew')}</p>}
                  {open.map(r => {
                    const type = directionOf(r);
                    return (
                      <div key={r.i} className={`grid grid-cols-[20px_minmax(0,1fr)] gap-2 items-start p-2 ${r.include ? '' : 'opacity-60'}`}>
                        <input
                          type="checkbox"
                          checked={r.include}
                          disabled={!r.target}
                          onChange={(e) => setImportRow(r.i, { include: e.target.checked })}
                          aria-label={r.desc}
                          className="mt-1 w-4 h-4"
                        />
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-xs font-medium text-primary truncate">{r.desc}</span>
                            <span className={`font-mono text-xs shrink-0 ${type === 'incomes' ? 'text-notion-green' : 'text-primary'}`}>
                              {type === 'incomes' ? '+' : '−'}{fmtCents(Math.abs(r.amount) + (type === 'expenses' ? Math.abs(r.fee || 0) : 0))}
                            </span>
                          </div>
                          <div className="text-[10px] text-tertiary">
                            {fmtDay(r.date)}{r.kind ? ` · ${r.kind.toLowerCase().replace(/_/g, ' ')}` : ''}
                            {r.ownTransfer && <span className="ms-1.5 px-1.5 py-px rounded bg-notion-tagBlue text-notion-blue font-medium">{t('importOwnTransfer')}</span>}
                            {r.target.startsWith('item:') && isTickedByHand(data, type, r.target.slice(5), r.date) && (
                              <span className="ms-1.5 px-1.5 py-px rounded bg-notion-tagGreen text-notion-green font-medium">{t('importReplacesTick')}</span>
                            )}
                          </div>
                          <select
                            value={r.target}
                            onChange={(e) => setImportRow(r.i, { target: e.target.value, include: !!e.target.value })}
                            className="w-full bg-subtle border border-subtle rounded px-2 py-1 text-[11px] text-primary"
                          >
                            <option value="">{t('importSkipOption')}</option>
                            {type === 'expenses'
                              ? data.groups.map(g => (
                                  <optgroup key={g.id} label={groupName(g)}>
                                    {itemsInGroup(g.id).map(c => <option key={c} value={`item:${c}`}>{c}</option>)}
                                    <option value={`new:${g.id}`}>＋ {t('importNewItem', { name: prettyPayee(r.desc) })}</option>
                                  </optgroup>
                                ))
                              : (
                                  <optgroup label={t('incomesHeader')}>
                                    {data.categories.incomes.map(c => <option key={c} value={`item:${c}`}>{c}</option>)}
                                    <option value="new:in">＋ {t('importNewItem', { name: prettyPayee(r.desc) })}</option>
                                  </optgroup>
                                )}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {skipped.length > 0 && (
                  <details className="text-[11px] text-tertiary">
                    <summary className="cursor-pointer">{t('importSkippedList', { n: skipped.length })}</summary>
                    <div className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                      {skipped.map(r => (
                        <div key={r.i} className="truncate">{fmtDay(r.date)} · {r.desc} · {fmtCents(r.amount)} · {t('importSkip_' + r.skip)}</div>
                      ))}
                    </div>
                  </details>
                )}
                <div className="flex gap-2 pt-2 border-t border-subtle">
                  <button onClick={close} className="flex-1 py-1.5 bg-subtle text-secondary rounded hover:text-primary">{t('cancelBtn')}</button>
                  <button
                    disabled={!chosen.length}
                    onClick={runImport}
                    className="flex-1 py-1.5 bg-primary text-surface font-semibold rounded disabled:opacity-40"
                  >
                    {t('importRun', { n: chosen.length })}
                  </button>
                </div>
              </Modal>
            );
          })()}

          {/* ASSISTANT */}
          {askModal && (
            <Modal size="max-w-lg" onClose={() => setAskModal(false)} title={<><span>✨</span><span>{t('askTitle')}</span></>}>
              <div className="max-h-[55vh] overflow-y-auto space-y-2">
                {askChat.length === 0 && (
                  <div className="space-y-2">
                    <p className="text-[11px] text-secondary leading-relaxed">{t('askIntro')}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {[t('askEx1'), t('askEx2'), t('askEx3')].map(ex => (
                        <button key={ex} onClick={() => setAskInput(ex)} className="text-[11px] px-2 py-1 rounded border border-subtle bg-subtle text-primary hover:border-strong text-start">{ex}</button>
                      ))}
                    </div>
                  </div>
                )}
                {askChat.map((msg, i) => (
                  <div key={i} className={msg.role === 'user' ? 'flex justify-end' : ''}>
                    <div dir="auto" className={`text-xs leading-relaxed whitespace-pre-wrap rounded-lg px-3 py-2 ${msg.role === 'user' ? 'bg-primary text-surface max-w-[85%]' : 'bg-subtle text-primary border border-subtle'}`}>
                      {msg.text}
                    </div>
                  </div>
                ))}
                {askBusy && <div className="text-[11px] text-tertiary px-1">{t('askThinking')}</div>}
              </div>
              {askError && <p className="text-[11px] text-notion-red">{askError}</p>}
              <div className="flex gap-2 items-end">
                <textarea
                  dir="auto"
                  rows={2}
                  value={askInput}
                  onChange={(e) => setAskInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion(); } }}
                  placeholder={t('askPlaceholder')}
                  maxLength={4000}
                  className="flex-1 bg-subtle border border-subtle rounded px-2 py-1.5 text-xs text-primary outline-none resize-none"
                />
                <button onClick={sendQuestion} disabled={askBusy || !askInput.trim()} className="px-3 py-2 bg-primary text-surface text-xs font-semibold rounded disabled:opacity-40">{t('askSend')}</button>
              </div>
              <div className="flex items-center justify-between text-[10px] text-tertiary">
                <span>{t('askPrivacy')}</span>
                {askChat.length > 0 && <button onClick={() => { setAskChat([]); setAskError(''); }} className="text-notion-blue hover:underline shrink-0 ms-2">{t('askNew')}</button>}
              </div>
            </Modal>
          )}

          {txModal && renderEntries()}
          {logModal && renderHistory()}
          {breakdownModal && renderSummary()}

          {/* RECEIPT SHEET */}
          {receiptSheet && (() => {
            const variableGroups = data.groups.filter(g => g.kind === 'variable');
            const withItems = variableGroups.filter(g => itemsInGroup(g.id).length > 0);
            return (
              <Modal onClose={() => setReceiptSheet(false)} title={<><span>🧾</span><span>{t('receiptSheetTitle')}</span></>}>
                <label className="flex items-baseline gap-1.5 border-b-2 border-strong focus-within:border-primary pb-1">
                  <input
                    autoFocus
                    inputMode="decimal"
                    value={receiptAmount}
                    onChange={(e) => { setReceiptAmount(e.target.value); setReceiptHint(false); }}
                    placeholder="0,00"
                    aria-label={t('replicateAmountLabel')}
                    className="flex-1 min-w-0 bg-transparent text-primary outline-none font-mono text-3xl font-bold text-end"
                  />
                  <span className="font-mono text-xl text-tertiary">€</span>
                </label>
                {receiptHint && <p className="text-[11px] text-notion-red">{t('receiptNeedAmount')}</p>}
                <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-1.5 items-center">
                  <input
                    type="date"
                    value={receiptDetails.date}
                    onChange={(e) => setReceiptDetails(p => ({ ...p, date: e.target.value }))}
                    aria-label={t('dateLabel')}
                    className="bg-subtle border border-subtle rounded px-2 py-1 text-xs text-primary"
                  />
                  <input
                    value={receiptDetails.note}
                    onChange={(e) => setReceiptDetails(p => ({ ...p, note: e.target.value }))}
                    placeholder={t('noteLabel')}
                    className="min-w-0 bg-subtle border border-subtle rounded px-2 py-1 text-xs text-primary"
                  />
                </div>
                <div>
                  <div className="text-[10px] text-secondary mb-1">{t('whoLabel')}</div>
                  <WhoPicker value={receiptDetails.who} onChange={(w) => setReceiptDetails(p => ({ ...p, who: w }))} />
                </div>
                <div className="text-[11px] text-secondary">{t('receiptWhere')}</div>
                {withItems.length === 0 ? (
                  <p className="text-[11px] text-tertiary">{t('receiptNoItems')}</p>
                ) : withItems.map(g => (
                  <div key={g.id} className="space-y-1.5">
                    <div className="text-[10px] text-tertiary">{groupName(g)}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {itemsInGroup(g.id).map(cat => (
                        <button
                          key={cat}
                          onClick={() => submitSheetReceipt(cat)}
                          className="ps-1 pe-3 py-1 rounded-full border border-strong bg-surface-elevated text-primary text-xs flex items-center gap-1.5 hover:border-primary"
                        >
                          <ItemIcon spec={iconFor('expenses', cat)} tint={GROUP_HEX[g.color]} size={20} />
                          {cat}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <button onClick={() => setReceiptSheet(false)} className="w-full py-1.5 bg-subtle text-secondary rounded hover:text-primary">
                  {t('cancelBtn')}
                </button>
              </Modal>
            );
          })()}

          {/* GROUP DIALOG */}
          {groupModal && (() => {
            const editing = groupModal.id ? data.groups.find(g => g.id === groupModal.id) : null;
            const itemCount = editing ? itemsInGroup(editing.id).length : 0;
            const others = editing ? data.groups.filter(g => g.id !== editing.id) : [];
            return (
              <Modal onClose={() => setGroupModal(null)} title={editing ? t('groupDialogEdit') : t('groupDialogNew')}>
                <div>
                  <label className="text-[10px] text-secondary font-medium block mb-1">{t('groupNameLabel')}</label>
                  <input
                    autoFocus
                    type="text"
                    value={groupForm.name}
                    onChange={(e) => setGroupForm(f => ({ ...f, name: e.target.value }))}
                    placeholder={t('groupNamePlaceholder')}
                    className="w-full bg-subtle border border-subtle rounded px-2.5 py-1.5 text-primary outline-none focus:border-strong font-medium"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-secondary font-medium block mb-1">{t('groupKindLabel')}</label>
                  <div className="grid grid-cols-3 gap-1 bg-subtle p-0.5 rounded border border-subtle">
                    {GROUP_KINDS.map(k => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setGroupForm(f => ({ ...f, kind: k }))}
                        className={`py-1 rounded text-[11px] ${groupForm.kind === k ? 'bg-surface text-primary font-semibold shadow-sm' : 'text-secondary'}`}
                      >
                        {kindLabel(k)}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-tertiary mt-1">{t('groupKindHelp_' + groupForm.kind)}</p>
                </div>
                <div>
                  <label className="text-[10px] text-secondary font-medium block mb-1">{t('groupColorLabel')}</label>
                  <div className="flex flex-wrap gap-2">
                    {GROUP_COLORS.map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setGroupForm(f => ({ ...f, color: c }))}
                        aria-label={c}
                        aria-pressed={groupForm.color === c}
                        className={`w-7 h-7 rounded-md border-2 ${groupForm.color === c ? 'border-primary' : 'border-transparent'}`}
                        style={{ background: GROUP_HEX[c] }}
                      ></button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 pt-2 border-t border-subtle">
                  <button onClick={() => setGroupModal(null)} className="flex-1 py-1.5 bg-subtle text-secondary rounded hover:text-primary">
                    {t('cancelBtn')}
                  </button>
                  <button
                    disabled={!groupForm.name.trim()}
                    onClick={saveGroup}
                    className="flex-1 py-1.5 bg-primary text-surface font-semibold rounded disabled:opacity-40"
                  >
                    {t('groupSave')}
                  </button>
                </div>

                {editing && others.length > 0 && (
                  <div className="pt-2 border-t border-subtle space-y-1.5">
                    {itemCount > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-secondary shrink-0">{t('groupDeleteMove', { n: itemCount })}</span>
                        <select
                          value={groupForm.moveTo}
                          onChange={(e) => setGroupForm(f => ({ ...f, moveTo: e.target.value }))}
                          className="flex-1 min-w-0 bg-subtle border border-subtle rounded px-2 py-1 text-primary outline-none"
                        >
                          {others.map(g => <option key={g.id} value={g.id}>{groupName(g)}</option>)}
                        </select>
                      </div>
                    )}
                    <button onClick={deleteGroup} className="w-full py-1.5 rounded bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 text-notion-red font-semibold">
                      {t('groupDelete')}
                    </button>
                  </div>
                )}
              </Modal>
            );
          })()}

          {/* REAL BALANCE MODAL */}
          {balanceModal && (() => {
            const monthName = monthLabel(selectedYear, selectedMonth);
            const start = balanceStartFromInput();
            return (
              <Modal onClose={() => setBalanceModal(false)} title={<><span>🏦</span><span>{t('fixBalanceTitle')}</span></>}>
                <div>
                  <label className="text-[10px] text-secondary font-medium block mb-1">
                    {balanceIsToday ? t('fixBalanceTodayLabel') : t('fixBalanceStartLabel', { month: monthName })}
                  </label>
                  <MoneyInput
                    value={balanceInput}
                    onChange={setBalanceInput}
                    autoFocus
                    className="py-1.5"
                    inputClass="text-primary font-semibold text-sm"
                  />
                </div>
                <p className="text-[11px] text-secondary leading-relaxed">
                  {balanceIsToday
                    ? t('fixBalanceTodayDesc', { month: monthName, in: fmt(currentMetrics.actualIn), out: fmt(currentMetrics.actualEx) })
                    : t('fixBalanceStartDesc', { month: monthName })}
                </p>
                {start !== null && balanceIsToday && (
                  <div className="p-2 rounded bg-subtle font-mono text-primary">{t('fixBalancePreview', { amount: fmt(start) })}</div>
                )}
                <div className="flex gap-2 pt-2 border-t border-subtle">
                  <button onClick={() => setBalanceModal(false)} className="flex-1 py-1.5 bg-subtle text-secondary rounded hover:text-primary">
                    {t('cancelBtn')}
                  </button>
                  <button
                    disabled={start === null}
                    onClick={applyBalance}
                    className="flex-1 py-1.5 bg-primary text-surface font-semibold rounded disabled:opacity-40"
                  >
                    {t('fixBalanceSave')}
                  </button>
                </div>
              </Modal>
            );
          })()}

          {search && (() => {
            const ql = search.q.trim().toLowerCase();
            const years = [...new Set((data.tx || []).map(x => x.date.slice(0, 4)))].sort();
            const hits = ql.length < 2 ? [] : (data.tx || []).filter(x => (search.yr === 'all' || x.date.startsWith(search.yr))
              && (x.cat.toLowerCase().includes(ql) || (x.note || '').toLowerCase().includes(ql) || String(x.amount).replace('.', ',').includes(ql) || String(x.amount).includes(ql)))
              .sort((a, b) => b.date.localeCompare(a.date));
            const out = round2(hits.filter(x => x.type === 'expenses').reduce((a2, x) => a2 + x.amount, 0));
            const inn = round2(hits.filter(x => x.type === 'incomes').reduce((a2, x) => a2 + x.amount, 0));
            const loc = lang === 'en' ? 'en-US' : lang === 'ar' ? 'ar-SY-u-nu-latn' : 'de-DE';
            return (
              <Modal size="max-w-lg" onClose={() => setSearch(null)} title={<><i className="fa-solid fa-magnifying-glass"></i><span>{t('srchTitle')}</span></>}>
                <input data-free type="search" autoFocus value={search.q} onChange={(e) => setSearch(p => ({ ...p, q: e.target.value }))} placeholder={t('srchPh')}
                  className="w-full bg-subtle border border-subtle rounded-xl px-3.5 py-2.5 text-[14px] text-primary outline-none focus:border-notion-blue" />
                <div className="flex flex-wrap gap-1.5">
                  {['all', ...years].map(y => (
                    <button key={y} onClick={() => setSearch(p => ({ ...p, yr: y }))}
                      className={`px-3 py-1 rounded-full text-[12px] border ${search.yr === y ? 'border-notion-blue bg-notion-blue/10 text-primary font-semibold' : 'border-subtle text-secondary'}`}>{y === 'all' ? t('srchAll') : y}</button>
                  ))}
                </div>
                {ql.length >= 2 && (
                  <div className="rounded-xl bg-subtle/60 px-3 py-2.5 text-[13px] flex flex-wrap gap-x-4 gap-y-1">
                    <span className="text-secondary">{t('srchFound', { n: hits.length })}</span>
                    {out > 0 && <span className="font-mono text-primary">− {fmtCents(out)}</span>}
                    {inn > 0 && <span className="font-mono text-notion-green">+ {fmtCents(inn)}</span>}
                  </div>
                )}
                <div className="space-y-1.5 stagger">
                  {hits.slice(0, 150).map(x => (
                    <button key={x.id} onClick={() => { setSearch(null); openEntry(x.id); }} className="w-full text-start flex items-center gap-2.5 rounded-xl bg-subtle/50 hover:bg-subtle px-2.5 py-2">
                      <ItemIcon spec={(x.note && autoIcon(x.note.split(' · ')[0])?.kind === 'brand') ? autoIcon(x.note.split(' · ')[0]) : iconFor(x.type, x.cat)} tint={tintFor(x.type, x.cat)} size={28} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] text-primary truncate">{x.cat}{x.note ? ` · ${x.note}` : ''}</span>
                        <span className="block text-[11px] text-tertiary">{new Date(x.date + 'T12:00').toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' })}{x.who ? ` · ${whoLabel(x.who)}` : ''}</span>
                      </span>
                      <span className={`font-mono text-[13px] ${x.type === 'incomes' ? 'text-notion-green' : 'text-primary'}`}>{x.type === 'incomes' ? '+' : '−'}{fmtCents(x.amount)}</span>
                    </button>
                  ))}
                  {ql.length < 2 && <p className="text-[12.5px] text-tertiary text-center py-4">{t('srchHint')}</p>}
                </div>
              </Modal>
            );
          })()}

          {itemSheet && (() => {
            const { type, cat } = itemSheet;
            if (!data.categories[type].includes(cat)) return null;
            const tint = tintFor(type, cat);
            const meta = getMeta(type, cat);
            const g = type === 'expenses' ? data.groups.find(x => x.id === meta.bracket) : null;
            const shop = type === 'expenses' && g?.kind === 'variable' && !meta.oneTime;
            const n = getNode(type, cat, selectedYear, selectedMonth);
            const plan = shop ? getTarget(g.id, selectedYear, selectedMonth) : n.budget;
            const groupSpent = shop ? data.categories.expenses.filter(c => getMeta('expenses', c).bracket === g.id).reduce((sum, c) => sum + getNode('expenses', c, selectedYear, selectedMonth).actual, 0) : n.actual;
            const loc = lang === 'en' ? 'en-US' : lang === 'ar' ? 'ar-SY-u-nu-latn' : 'de-DE';
            const prefix = `${selectedYear}-${pad2(ALL_MONTHS.indexOf(selectedMonth) + 1)}-`;
            const entries = (data.tx || []).filter(x => x.type === type && x.cat === cat && x.date.startsWith(prefix)).sort((a, b) => b.date.localeCompare(a.date));
            const idx = timelineIndex(selectedYear, selectedMonth);
            const hist = TIMELINE.slice(Math.max(0, idx - 5), idx + 1).map(p => ({ ...p, v: getNode(type, cat, p.yr, p.m).actual }));
            const hmax = Math.max(1, ...hist.map(h => h.v));
            const kind = (x) => x.source === 'tick' ? t(type === 'incomes' ? 'calKind_income' : 'calKind_bill') : x.source === 'legacy' ? t('calKind_earlier') : x.source === 'loan' ? t('calKind_loan') : x.source === 'import' ? t('itemFromBank') : '';
            const accName = (id) => data.accounts.find(a => a.id === id)?.name || '';
            return (
              <Modal size="max-w-lg" onClose={() => setItemSheet(null)} title={<><ItemIcon spec={iconFor(type, cat)} tint={tint} size={22} /><span className="truncate">{cat}</span></>}>
                <div className="rounded-3xl p-4 space-y-3" style={{ background: `linear-gradient(135deg, ${tint}26, ${tint}0d)` }}>
                  <div className="flex items-center justify-between gap-2">
                    <button onClick={() => goMonth(TIMELINE[idx - 1])} disabled={idx <= 0} aria-label="prev" className="w-8 h-8 rounded-full bg-surface/70 text-secondary disabled:opacity-30"><i className="fa-solid fa-chevron-left rtl:rotate-180 text-xs"></i></button>
                    <div className="text-center">
                      <div className="text-[12px]" style={{ color: tint }}>{g ? groupName(g) : t('incomesHeader')} · {formatMonth(selectedMonth, lang)} {selectedYear}</div>
                      <div className={`text-[32px] font-bold leading-tight font-mono ${type === 'incomes' ? 'text-notion-green' : 'text-primary'}`}><AnimatedNumber value={n.actual} format={fmtCents} /></div>
                      <div className="text-[12px] text-secondary">{plan > 0 ? (shop ? t('itemGroupOf', { spent: fmt(groupSpent), target: fmt(plan), group: groupName(g) }) : t('itemOfPlan', { plan: fmtCents(plan) })) : t('itemNoPlan')}</div>
                    </div>
                    <button onClick={() => goMonth(TIMELINE[idx + 1])} disabled={idx >= TIMELINE.length - 1} aria-label="next" className="w-8 h-8 rounded-full bg-surface/70 text-secondary disabled:opacity-30"><i className="fa-solid fa-chevron-right rtl:rotate-180 text-xs"></i></button>
                  </div>
                  {plan > 0 && (
                    <div className="h-2 rounded-full bg-surface/70 overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, (shop ? groupSpent : n.actual) / plan * 100)}%`, background: (shop ? groupSpent : n.actual) > plan + 0.5 ? '#ef4444' : tint }}></div>
                    </div>
                  )}
                  <div className="flex items-end gap-1.5 h-14 pt-1">
                    {hist.map(h => (
                      <button key={`${h.yr}${h.m}`} onClick={() => goMonth({ yr: h.yr, m: h.m })} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
                        <span className="w-full rounded-md transition-all" style={{ height: `${Math.max(4, h.v / hmax * 100)}%`, background: h.yr === selectedYear && h.m === selectedMonth ? tint : tint + '55' }}></span>
                        <span className="text-[9.5px] text-secondary">{formatMonth(h.m, lang)}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className={`grid ${shop ? 'grid-cols-2' : 'grid-cols-3'} gap-2`}>
                  <button onClick={() => { setItemSheet(null); addFor(type, cat); }} className="py-2.5 rounded-2xl bg-notion-blue text-white text-[12px] font-semibold flex flex-col items-center gap-1">
                    <i className="fa-solid fa-plus"></i>{t('itemAdd')}
                  </button>
                  {!shop ? (
                    <button onClick={() => toggleDone(type, cat)} className={`py-2.5 rounded-2xl text-[12px] font-semibold flex flex-col items-center gap-1 ${n.actual > 0 ? 'bg-emerald-500/15 text-notion-green' : 'bg-subtle text-primary'}`}>
                      <i className="fa-solid fa-check"></i>{n.actual > 0 ? t(type === 'incomes' ? 'itemReceived' : 'itemPaid') : t(type === 'incomes' ? 'itemMarkReceived' : 'itemMarkPaid')}
                    </button>
                  ) : null}
                  <button onClick={() => { setItemSheet(null); handleOpenEditCategory(type, cat); }} className="py-2.5 rounded-2xl bg-subtle text-primary text-[12px] font-semibold flex flex-col items-center gap-1">
                    <i className="fa-solid fa-sliders"></i>{t('itemSettings')}
                  </button>
                </div>
                <div key={`${selectedYear}${selectedMonth}`} className="space-y-2 stagger">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">{t('itemEntries', { n: entries.length })}</div>
                    {entries.length > 0 && (
                      <button onClick={() => setItemSheet(p => ({ ...p, sel: p.sel ? null : [] }))} className="text-[12px] text-notion-blue font-medium">{itemSheet.sel ? t('selDone') : t('selStart')}</button>
                    )}
                  </div>
                  {itemSheet.sel && (() => {
                    const sel = itemSheet.sel;
                    const allIds = (data.tx || []).filter(x => x.type === type && x.cat === cat).map(x => x.id);
                    const monthIds = entries.map(x => x.id);
                    const to = itemSheet.to || '';
                    return (
                      <div className="pop-in rounded-xl border border-notion-blue/30 bg-notion-blue/5 p-2.5 space-y-2">
                        <div className="flex flex-wrap gap-1.5 text-[12px]">
                          <button onClick={() => setItemSheet(p => ({ ...p, sel: monthIds }))} className="px-2.5 py-1 rounded-full border border-subtle bg-surface">{t('selMonth', { n: monthIds.length })}</button>
                          <button onClick={() => setItemSheet(p => ({ ...p, sel: allIds }))} className="px-2.5 py-1 rounded-full border border-subtle bg-surface">{t('selAllMonths', { n: allIds.length })}</button>
                          {(() => { const plan = n.budget; const notPlan = allIds.filter(id => { const x = data.tx.find(y => y.id === id); return x && Math.abs(x.amount - plan) > 0.004; });
                            return plan > 0 && notPlan.length < allIds.length ? <button onClick={() => setItemSheet(p => ({ ...p, sel: notPlan }))} className="px-2.5 py-1 rounded-full border border-subtle bg-surface">{t('selNotPlan', { amount: fmtCents(plan), n: notPlan.length })}</button> : null; })()}
                          {sel.length > 0 && <button onClick={() => setItemSheet(p => ({ ...p, sel: [] }))} className="px-2.5 py-1 text-tertiary">{t('selNone')}</button>}
                        </div>
                        <div className="flex items-center gap-2">
                          <input data-free list="move-targets" value={to} onChange={(e) => setItemSheet(p => ({ ...p, to: e.target.value }))} placeholder={t('moveTo')}
                            style={{ flex: '1 1 0', minWidth: 0 }} className="bg-surface border border-subtle rounded-lg px-2.5 py-2 text-[12.5px] text-primary outline-none focus:border-notion-blue" />
                          <datalist id="move-targets">{data.categories[type].filter(c => c !== cat).map(c => <option key={c} value={c} />)}</datalist>
                          <button disabled={!sel.length || !to.trim() || to.trim() === cat} onClick={() => { moveEntries(type, sel, to, g && g.kind === 'variable' ? g.id : 'household'); setItemSheet(p => ({ ...p, sel: null, to: '' })); }}
                            className="px-3 py-2 rounded-lg bg-notion-blue text-white text-[12.5px] font-semibold disabled:opacity-40 shrink-0">{t('moveBtn', { n: sel.length })}</button>
                        </div>
                        {to.trim() && !data.categories[type].some(c => c.toLowerCase() === to.trim().toLowerCase()) && <div className="text-[11px] text-tertiary">{t('moveNew', { name: to.trim() })}</div>}
                      </div>
                    );
                  })()}
                  {entries.length === 0 && <p className="text-[13px] text-secondary py-3 text-center">{t('itemNoEntries')}</p>}
                  {entries.map(x => (
                    <button key={x.id} onClick={() => itemSheet.sel ? setItemSheet(p => ({ ...p, sel: p.sel.includes(x.id) ? p.sel.filter(i => i !== x.id) : [...p.sel, x.id] })) : openEntry(x.id)}
                      className={`w-full text-start flex items-center gap-3 rounded-2xl px-3 py-2.5 active:scale-[.99] transition ${itemSheet.sel && itemSheet.sel.includes(x.id) ? 'bg-notion-blue/15 ring-1 ring-notion-blue' : 'bg-subtle/60 hover:bg-subtle'}`}>
                      {itemSheet.sel && <i className={`fa-${itemSheet.sel.includes(x.id) ? 'solid fa-circle-check text-notion-blue' : 'regular fa-circle text-tertiary'} text-[18px] shrink-0`}></i>}
                      {(() => { const sh = x.note ? autoIcon(x.note.split(' · ')[0]) : null; return sh && sh.kind === 'brand'
                        ? <span className="relative shrink-0"><ItemIcon spec={sh} size={34} /></span>
                        : <span className="relative shrink-0"><ItemIcon spec={iconFor(type, cat)} tint={tint} size={34} /></span>; })()}
                      <span className="w-11 shrink-0 text-center rounded-xl bg-surface py-1">
                        <span className="block text-[16px] font-bold leading-none text-primary">{x.undated ? '–' : +x.date.slice(8, 10)}</span>
                        <span className="block text-[9.5px] text-secondary">{x.undated ? '' : new Date(x.date + 'T12:00').toLocaleDateString(loc, { weekday: 'short' })}</span>
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] text-primary truncate">{x.note || kind(x) || cat}</span>
                        <span className="block text-[11px] text-tertiary truncate">{[x.who ? whoLabel(x.who) : '', accName(x.account), x.note ? kind(x) : ''].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className={`font-mono text-[14px] font-semibold ${type === 'incomes' ? 'text-notion-green' : 'text-primary'}`}>{type === 'incomes' ? '+' : '−'}{fmtCents(x.amount)}</span>
                      <i className="fa-solid fa-chevron-right rtl:rotate-180 text-[10px] text-tertiary"></i>
                    </button>
                  ))}
                </div>
              </Modal>
            );
          })()}

          {entrySheet && (() => {
            const f = entrySheet;
            const set = (patch) => setEntrySheet(prev => ({ ...prev, ...patch }));
            const loc = lang === 'en' ? 'en-US' : lang === 'ar' ? 'ar-SY-u-nu-latn' : 'de-DE';
            const chip = (on) => `px-3 py-1.5 rounded-full text-[12px] border transition ${on ? 'border-notion-blue bg-notion-blue/10 text-primary font-semibold' : 'border-subtle bg-subtle/60 text-secondary'}`;
            const ok = parseAmount(f.amount) !== null;
            return (
              <Modal size="max-w-md" onClose={() => setEntrySheet(null)} title={<><ItemIcon spec={f.cat === '__new' ? (autoIcon(f.newName) || { kind: 'symbol', icon: 'fa-plus' }) : iconFor(f.type, f.cat)} tint={tintFor(f.type, f.cat)} size={22} /><span>{t('entryTitle')}</span></>}>
                <div className="flex items-baseline gap-2 rounded-2xl px-4 py-3 bg-subtle/60">
                  <input data-free value={f.amount} onChange={(e) => set({ amount: e.target.value })} inputMode="decimal" aria-label={t('bkAmount')}
                    className={`flex-1 min-w-0 bg-transparent outline-none text-[34px] leading-none font-semibold font-mono ${f.type === 'incomes' ? 'text-notion-green' : 'text-primary'}`} />
                  <span className="text-[20px] text-tertiary font-mono">€</span>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">{f.type === 'incomes' ? t('bkWhereIn') : t('bkWhere')}</span>
                    {f.cat !== '__new' && (
                      <button type="button" onClick={() => { const c = f.cat, ty = f.type; setEntrySheet(null); setItemSheet(null); handleOpenEditCategory(ty, c); }}
                        className="text-[11.5px] text-notion-blue hover:underline"><i className="fa-solid fa-sliders me-1 text-[10px]"></i>{t('entryItemSettings')}</button>
                    )}
                  </div>
                  <button type="button" onClick={() => set({ pick: !f.pick })}
                    className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2 border transition ${f.pick ? 'border-notion-blue bg-notion-blue/5' : 'border-subtle bg-subtle/60'}`}>
                    {f.cat === '__new'
                      ? (autoIcon(f.newName) ? <ItemIcon spec={autoIcon(f.newName)} size={28} /> : <span className="w-[28px] h-[28px] rounded-[9px] bg-notion-blue/15 text-notion-blue flex items-center justify-center"><i className="fa-solid fa-plus text-xs"></i></span>)
                      : <ItemIcon spec={iconFor(f.type, f.cat)} tint={tintFor(f.type, f.cat)} size={28} />}
                    <span className="flex-1 min-w-0 text-start text-[13.5px] text-primary truncate">{f.cat === '__new' ? (f.newName || t('shopNewItem')) : f.cat}</span>
                    <i className={`fa-solid fa-chevron-down text-[10px] text-tertiary transition-transform ${f.pick ? 'rotate-180' : ''}`}></i>
                  </button>
                  {f.pick && (() => {
                    const ql = f.q.trim().toLowerCase();
                    const list = data.categories[f.type].filter(c => !ql || c.toLowerCase().includes(ql))
                      .sort((a2, b2) => (bkUsage[f.type + '|' + b2] || 0) - (bkUsage[f.type + '|' + a2] || 0)).slice(0, ql ? 24 : 12);
                    const sugg = ql.length >= 2 ? merchantMatch(f.q, data.categories[f.type], f.type).slice(0, 4) : [];
                    const exact = data.categories[f.type].some(c => c.toLowerCase() === ql);
                    return (
                      <div className="pop-in rounded-xl border border-subtle bg-surface p-2 space-y-2">
                        <input data-free type="search" autoFocus value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder={t('bkSearchBig')}
                          className="w-full bg-subtle border border-subtle rounded-lg px-3 py-2 text-[13px] text-primary outline-none focus:border-notion-blue" />
                        <div className="grid grid-cols-3 gap-1.5 max-h-[220px] overflow-y-auto stagger">
                          {list.map(c => (
                            <button key={c} type="button" onClick={() => set({ cat: c, pick: false, q: '' })}
                              className={`flex flex-col items-center gap-1 rounded-xl px-1 py-2 border ${f.cat === c ? 'border-notion-blue bg-notion-blue/10' : 'border-transparent bg-subtle/50 hover:bg-subtle'}`}>
                              <ItemIcon spec={iconFor(f.type, c)} tint={tintFor(f.type, c)} size={26} />
                              <span className="w-full text-center text-[10.5px] leading-tight truncate text-secondary">{c}</span>
                            </button>
                          ))}
                        </div>
                        {(sugg.length > 0 || (ql && !exact)) && (
                          <div className="flex flex-wrap gap-1.5">
                            {sugg.map(([name, gid]) => (
                              <button key={name} type="button" onClick={() => set({ cat: '__new', newName: name, newGroup: resolveGroup(data.groups, gid).id, pick: false, q: '' })}
                                className="flex items-center gap-1.5 ps-1 pe-2.5 py-1 rounded-full border border-subtle bg-subtle/50 hover:border-notion-blue">
                                <ItemIcon spec={autoIcon(name) || { kind: 'symbol', icon: GROUP_ICONS[resolveGroup(data.groups, gid).id] || 'fa-tag' }} size={20} />
                                <span className="text-[12px] text-primary">+ {name}</span>
                              </button>
                            ))}
                            {ql && !exact && !sugg.some(([name]) => name.toLowerCase() === ql) && (
                              <button type="button" onClick={() => set({ cat: '__new', newName: f.q.trim(), pick: false, q: '' })}
                                className="px-3 py-1 rounded-full border border-dashed border-strong text-[12px] text-notion-blue">+ {t('entryCreate', { name: f.q.trim() })}</button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  {f.cat === '__new' && (
                    <div className="pop-in grid grid-cols-1 gap-2">
                      <input data-free value={f.newName} onChange={(e) => set({ newName: e.target.value })} placeholder={t('bkNewName')}
                        className="bg-subtle border border-subtle rounded-lg px-2.5 py-2 text-[13px] text-primary outline-none focus:border-strong" />
                      {f.type === 'expenses' && (
                        <select data-free value={f.newGroup || (data.groups.find(g => g.kind === 'variable') || data.groups[0]).id} onChange={(e) => set({ newGroup: e.target.value })}
                          className="bg-subtle border border-subtle rounded-lg px-2 py-2 text-[13px] text-primary">
                          {data.groups.map(g => <option key={g.id} value={g.id}>{groupName(g)}</option>)}
                        </select>
                      )}
                    </div>
                  )}
                  {f.cat !== f.origCat && (() => {
                    const n = sameEntries(f).length;
                    if (!n) return null;
                    return (
                      <label className="pop-in flex items-start gap-2.5 rounded-xl bg-notion-blue/5 border border-notion-blue/30 p-2.5 cursor-pointer">
                        <input data-free type="checkbox" checked={!!f.moveAll} onChange={(e) => set({ moveAll: e.target.checked })} className="mt-0.5 w-4 h-4" />
                        <span className="text-[12px] text-primary leading-snug">{t('entryMoveAll', { n, amount: fmtCents(f.origAmount), from: f.origCat })}</span>
                      </label>
                    );
                  })()}
                </div>
                <div className="space-y-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">{t('bkWhen')}</span>
                  <div className="flex items-center gap-2">
                    <input data-free type="date" value={f.date} onChange={(e) => e.target.value && set({ date: e.target.value, undated: false })} className="flex-1 bg-subtle border border-subtle rounded-xl px-3 py-2 text-[13px] text-primary" />
                    <span className="text-[12px] text-secondary">{new Date(f.date + 'T12:00').toLocaleDateString(loc, { weekday: 'long' })}</span>
                  </div>
                </div>
                {data.accounts.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">{t('bkAccount')}</span>
                    <div className="flex flex-wrap gap-1.5">
                      <button type="button" onClick={() => set({ account: '' })} className={chip(!f.account)}>{t('bkNoAccount')}</button>
                      {data.accounts.map(a => <button key={a.id} type="button" onClick={() => set({ account: a.id })} className={chip(f.account === a.id)}>{a.name}</button>)}
                    </div>
                  </div>
                )}
                <div className="space-y-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">{t('bkWho')}</span>
                  <div className="flex flex-wrap gap-1.5">{WHO.map(w => <button key={w} type="button" onClick={() => set({ who: w })} className={chip(f.who === w)}>{whoLabel(w)}</button>)}</div>
                </div>
                <input data-free value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder={t('bkNote')}
                  className="w-full bg-subtle border border-subtle rounded-xl px-3 py-2.5 text-[13px] text-primary outline-none" />
                <div className="flex gap-2 pt-1">
                  <button onClick={() => { deleteTx(f.id); setEntrySheet(null); }} className="px-4 py-2.5 rounded-xl bg-red-500/10 text-notion-red text-[13px] font-semibold"><i className="fa-solid fa-trash-can me-1.5"></i>{t('deleteCategoryBtn')}</button>
                  <button onClick={saveEntry} disabled={!ok} className="flex-1 py-2.5 rounded-xl bg-notion-blue text-white text-[13px] font-semibold disabled:opacity-40">{t('bkSave')}</button>
                </div>
              </Modal>
            );
          })()}

          {arrangeOpen && (
            <Modal size="max-w-sm" onClose={() => setArrangeOpen(false)} title={<><i className="fa-solid fa-sliders"></i><span>{t('ovArrange')}</span></>}>
              <p className="text-[12px] text-secondary">{t('ovArrangeHint')}</p>
              <div className="space-y-1.5">
                {ovOrder.map((k, i) => (
                  <div key={k} className={`flex items-center gap-2 rounded-xl px-3 py-2 ${ovHidden[k] ? 'bg-subtle/30' : 'bg-subtle/70'}`}>
                    <span className={`flex-1 text-[13px] truncate ${ovHidden[k] ? 'text-tertiary line-through' : 'text-primary'}`}>{t(OV_NAMES[k])}</span>
                    <button onClick={() => setOvHidden({ ...ovHidden, [k]: !ovHidden[k] })} aria-label={t('ovToggle')} className="w-8 h-8 rounded-full hover:bg-surface text-secondary">
                      <i className={`fa-solid ${ovHidden[k] ? 'fa-eye-slash' : 'fa-eye'} text-[12px]`}></i>
                    </button>
                    <button disabled={i === 0} onClick={() => { const v = [...ovOrder]; [v[i - 1], v[i]] = [v[i], v[i - 1]]; setOvOrder(v); }} aria-label="up" className="w-8 h-8 rounded-full hover:bg-surface text-secondary disabled:opacity-25">
                      <i className="fa-solid fa-arrow-up text-[12px]"></i>
                    </button>
                    <button disabled={i === ovOrder.length - 1} onClick={() => { const v = [...ovOrder]; [v[i + 1], v[i]] = [v[i], v[i + 1]]; setOvOrder(v); }} aria-label="down" className="w-8 h-8 rounded-full hover:bg-surface text-secondary disabled:opacity-25">
                      <i className="fa-solid fa-arrow-down text-[12px]"></i>
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => { setOvOrder(OV_DEFAULT); setOvHidden({}); }} className="flex-1 py-2 rounded-lg bg-subtle text-secondary text-xs">{t('ovReset')}</button>
                <button onClick={() => setArrangeOpen(false)} className="flex-1 py-2 rounded-lg bg-primary text-surface text-xs font-semibold">{t('ovDone')}</button>
              </div>
            </Modal>
          )}

          {/* NEW LOAN */}
          {newLoan && (() => {
            const f = newLoan;
            const set = (patch) => setNewLoan(prev => ({ ...prev, ...patch, error: '' }));
            const amount = parseFloat(String(f.amount).replace(',', '.')) || 0;
            const pos = dateToMonth(f.date);
            const startIdx = TIMELINE.findIndex(x => timelineKey(x.yr, x.m) === f.start);
            const parts = f.n > 0 && amount > 0 ? loanSplit(amount, f.n) : [];
            const months = parts.map((_, i) => TIMELINE[startIdx + i]).filter(Boolean).map(p => `${formatMonth(p.m, lang)} ${p.yr}`);
            const borrowed = f.type === 'borrowed';
            const inputCls = 'w-full bg-subtle border border-subtle rounded-lg px-2.5 py-2 text-[13px] text-primary outline-none focus:border-strong';
            return (
              <Modal size="max-w-md" onClose={() => setNewLoan(null)} title={<><span>🤝</span><span>{t('newLoanTitle')}</span></>}>
                <Segmented full options={[['borrowed', t('loanBorrowed')], ['lent', t('loanLent')]]} value={f.type} onChange={(v) => set({ type: v })} />
                <div className="grid grid-cols-2 gap-2">
                  <div className="col-span-2">
                    <label className="text-[11px] text-secondary font-medium block mb-1">{borrowed ? t('loanLenderLabel') : t('loanBorrowerLabel')}</label>
                    <input autoFocus value={f.person} onChange={(e) => set({ person: e.target.value })} placeholder={t('loanPersonPh')} className={inputCls} />
                  </div>
                  <div>
                    <label className="text-[11px] text-secondary font-medium block mb-1">{t('loanAmount')}</label>
                    <input inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} placeholder="0,00 €" className={`${inputCls} text-end font-mono`} />
                  </div>
                  <div>
                    <label className="text-[11px] text-secondary font-medium block mb-1">{t('loanDate')}</label>
                    <input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} className={inputCls} />
                  </div>
                  <div className="col-span-2">
                    <label className="text-[11px] text-secondary font-medium block mb-1">{t('loanRate')}</label>
                    <input inputMode="decimal" value={f.rate || ''} onChange={(e) => set({ rate: e.target.value })} placeholder="0" className={`${inputCls} font-mono`} />
                  </div>
                </div>
                <label className="flex items-start gap-2.5 p-2.5 rounded-xl bg-subtle/60 cursor-pointer">
                  <input type="checkbox" checked={f.book} onChange={(e) => set({ book: e.target.checked })} className="mt-0.5 w-4 h-4" />
                  <span className="text-[12px] text-primary leading-snug">
                    {t(borrowed ? 'loanBookIn' : 'loanBookOut', { month: pos ? `${formatMonth(pos.m, lang)} ${pos.yr}` : '' })}
                    <span className="block text-[11px] text-tertiary">{t('loanBookHint')}</span>
                  </span>
                </label>
                <div className="space-y-2">
                  <label className="text-[11px] text-secondary font-medium block">{t(borrowed ? 'loanInstallments' : 'loanBackInstallments')}</label>
                  <Segmented full size="sm" options={[[0, t('loanNoPlan')], [1, '1×'], [2, '2×'], [3, '3×'], [4, '4×'], [6, '6×']]} value={f.n} onChange={(v) => set({ n: v })} />
                  {f.n > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-secondary shrink-0">{t('loanFirstMonth')}</span>
                      <select value={f.start} onChange={(e) => set({ start: e.target.value })} className="flex-1 bg-subtle border border-subtle rounded-lg px-2 py-1.5 text-[12px] text-primary">
                        {TIMELINE.map(({ yr, m }) => <option key={`${yr}|${m}`} value={`${yr}|${m}`}>{formatMonth(m, lang)} {yr}</option>)}
                      </select>
                    </div>
                  )}
                  {parts.length > 0 && (
                    <p className="text-[12px] text-secondary">{t('loanPreview', { n: parts.length, amount: fmtCents(parts[0]), months: months.join(', ') })}</p>
                  )}
                </div>
                {f.error && <p className="text-[12px] text-notion-red">{f.error}</p>}
                <div className="flex gap-2 pt-1">
                  <button onClick={() => setNewLoan(null)} className="flex-1 py-2 rounded-lg bg-subtle text-secondary text-xs font-medium">{t('cancelBtn')}</button>
                  <button onClick={saveNewLoan} className="flex-1 py-2 rounded-lg bg-primary text-surface text-xs font-semibold">{t('loanSave')}</button>
                </div>
              </Modal>
            );
          })()}

          {/* LOAN EDITOR: change an existing loan and its repayment plan */}
          {loanEdit && (() => {
            const item = (data.ious || []).find(i => i.id === loanEdit);
            if (!item) return null;
            const update = (patch) => mutate(d => { const x = d.ious.find(i => i.id === item.id); if (x) Object.assign(x, patch); });
            const cat = repayItemOf(item);
            const rt = repayTypeOf(item);
            const sibs = loanSiblings(item);
            const shared = sibs.length > 1;
            // A shared repayment item covers all loans on it together.
            const total = shared ? sibs.reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0) : (parseFloat(item.amount) || 0);
            const rows = cat ? TIMELINE.filter(({ yr, m }) => { const n = getNode(rt, cat, yr, m); return n.budget > 0 || n.actual > 0; }) : [];
            const repaid = shared ? TIMELINE.reduce((sum, { yr, m }) => sum + getNode(rt, cat, yr, m).actual, 0) : repaidOf(item);
            const planned = rows.reduce((sum, { yr, m }) => { const n = getNode(rt, cat, yr, m); return sum + (n.actual > 0 ? 0 : n.budget); }, 0);
            const gap = round2(total - repaid - planned);
            const inputCls = 'w-full bg-subtle border border-subtle rounded-lg px-2.5 py-1.5 text-primary outline-none focus:border-strong';
            return (
              <Modal size="max-w-md" onClose={() => setLoanEdit(null)} title={<><span>🤝</span><span>{t('loanEditTitle')}</span></>}>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-secondary font-medium block mb-1">{t('loanPerson')}</label>
                    <input value={item.person} onChange={(e) => update({ person: e.target.value })} className={inputCls} />
                  </div>
                  <div>
                    <label className="text-[10px] text-secondary font-medium block mb-1">{t('loanAmount')}</label>
                    <MoneyInput value={parseFloat(item.amount) || 0} hideZero={false} className="w-full" onChange={(v) => mutate(d => {
                      const x = d.ious.find(i => i.id === item.id);
                      if (!x) return;
                      const amount = Math.round((parseFloat(v) || 0) * 100) / 100;
                      if (x.booked && x.booked.cat) { applyLoanMoney(d, x, 1, round2(amount - x.booked.amount)); x.booked.amount = amount; }
                      x.amount = amount;
                    })} />
                  </div>
                  <div>
                    <label className="text-[10px] text-secondary font-medium block mb-1">{t('loanDate')}</label>
                    <input value={item.date || ''} onChange={(e) => update({ date: e.target.value })} className={inputCls} />
                  </div>
                  <div>
                    <label className="text-[10px] text-secondary font-medium block mb-1">{t('loanType')}</label>
                    <select value={item.type} onChange={(e) => update({ type: e.target.value })} className={inputCls}>
                      <option value="borrowed">{t('iouOptBorrowed')}</option>
                      <option value="lent">{t('iouOptLent')}</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="text-[10px] text-secondary font-medium block mb-1">{t('loanRate')}</label>
                    <input inputMode="decimal" value={item.rate ?? ''} placeholder="0"
                      onChange={(e) => { const v = e.target.value.replace(',', '.'); update({ rate: v === '' ? null : Math.max(0, Math.min(100, parseFloat(v) || 0)) }); }}
                      className={`${inputCls} font-mono`} />
                  </div>
                </div>

                {(() => {
                  const st = loanMoneyState(item);
                  const b = item.booked;
                  const isB = item.type === 'borrowed';
                  return (
                    <div className={`rounded-xl px-3 py-2.5 space-y-2 ${st === 'unknown' || st === 'off' ? 'bg-amber-500/10' : 'bg-subtle/60'}`}>
                      <div className="text-[12px] font-semibold text-primary">{t('loanMoneyTitle')}</div>
                      {st === 'booked' && (
                        <div className="flex items-center gap-2">
                          <span className="flex-1 text-[12px] text-secondary">{t(isB ? 'loanCountedIn' : 'loanCountedOut', { amount: fmt(b.amount), item: b.cat, month: `${formatMonth(b.m, lang)} ${b.yr}` })}</span>
                          <button onClick={() => unbookLoan(item.id)} className="px-2 py-1 rounded-lg bg-surface text-secondary text-[11px] shrink-0">{t('loanUnbook')}</button>
                        </div>
                      )}
                      {st === 'earlier' && <div className="text-[12px] text-secondary">{t('loanCountedEarlier')}</div>}
                      {(st === 'unknown' || st === 'off') && (
                        <>
                          <div className="text-[12px] text-secondary">{t(st === 'off' ? 'loanNotCounted' : 'loanMaybeCounted', { kind: t(isB ? 'loanAsIncome' : 'loanAsExpense') })}</div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <select value={loanBookPos || timelineKey(nowPosLoan().yr, nowPosLoan().m)} onChange={(e) => setLoanBookPos(e.target.value)}
                              className="bg-surface border border-subtle rounded-lg px-2 py-1.5 text-[12px] text-primary">
                              {TIMELINE.map(({ yr, m }) => <option key={`${yr}|${m}`} value={timelineKey(yr, m)}>{formatMonth(m, lang)} {yr}</option>)}
                            </select>
                            <button onClick={() => { const [yr, m] = (loanBookPos || timelineKey(nowPosLoan().yr, nowPosLoan().m)).split('|'); bookLoanNow(item.id, { yr: parseInt(yr), m }); }}
                              className="px-3 py-1.5 rounded-lg bg-primary text-surface text-[12px] font-semibold">{t(isB ? 'loanBookInBtn' : 'loanBookOutBtn')}</button>
                            {st === 'unknown' && <button onClick={() => markLoanCounted(item.id)} className="px-2 py-1.5 rounded-lg bg-surface text-secondary text-[11px]">{t('loanAlreadyCounted')}</button>}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })()}

                {(item.type === 'borrowed' || cat) && (
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-semibold text-primary">{t('loanSchedule')}</span>
                      <select value={cat || ''} onChange={(e) => update({ repayCat: e.target.value || null })} className="max-w-[55%] bg-subtle border border-subtle rounded-lg px-2 py-1 text-[11px] text-secondary">
                        <option value="">{t('iouLinkRepay')}</option>
                        {data.categories[rt].map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    {shared && <p className="text-[11px] text-secondary">{t('loanShared', { n: sibs.length, amount: fmtCents(total) })}</p>}
                    {cat && (
                      <>
                        {rows.length === 0 && <p className="text-[11px] text-tertiary">{t('loanNoSchedule')}</p>}
                        {rows.map(({ yr, m }) => {
                          const n = getNode(rt, cat, yr, m);
                          const paid = n.actual > 0;
                          return (
                            <div key={`${yr}|${m}`} className="grid grid-cols-[minmax(0,1fr)_7rem_auto_auto] items-center gap-2 rounded-xl bg-subtle/60 ps-3 pe-1.5 py-1.5">
                              <span className="text-[12px] text-primary truncate">{formatMonth(m, lang)} {yr}</span>
                              <MoneyInput value={paid ? n.actual : n.budget} hideZero={false}
                                onChange={(v) => updateNode(rt, cat, yr, m, paid ? 'actual' : 'budget', v)} className="w-28 bg-surface" />
                              <button type="button" onClick={() => updateNode(rt, cat, yr, m, 'actual', paid ? 0 : n.budget)} aria-pressed={paid}
                                className={`h-7 px-2 rounded-lg text-[11px] font-medium ${paid ? 'bg-notion-green text-white' : 'border border-strong text-secondary'}`}>
                                {paid ? `✓ ${t('loanPaid')}` : t('loanPlan')}
                              </button>
                              <button type="button" aria-label={t('iouDelete')} onClick={() => mutate(d => { const node = d.values[yr][rt][cat]?.[m]; if (node) { node.budget = 0; setActualTx(d, rt, cat, yr, m, 0); } })}
                                className="w-7 h-7 rounded-full text-tertiary hover:text-notion-red"><i className="fa-solid fa-xmark text-[11px]"></i></button>
                            </div>
                          );
                        })}
                        <div className="flex items-center gap-2">
                          <select value={loanAddPos} onChange={(e) => setLoanAddPos(e.target.value)} className="flex-1 bg-subtle border border-subtle rounded-lg px-2 py-1.5 text-[12px] text-primary">
                            <option value="">{t('loanAddMonth')}</option>
                            {TIMELINE.filter(({ yr, m }) => { const n = getNode(rt, cat, yr, m); return !(n.budget > 0 || n.actual > 0); })
                              .map(({ yr, m }) => <option key={`${yr}|${m}`} value={`${yr}|${m}`}>{formatMonth(m, lang)} {yr}</option>)}
                          </select>
                          <button type="button" disabled={!loanAddPos} onClick={() => {
                              const [yr, m] = loanAddPos.split('|');
                              updateNode(rt, cat, parseInt(yr), m, 'budget', Math.max(0, gap));
                              setLoanAddPos('');
                            }} className="h-8 px-3 rounded-lg bg-primary text-surface text-[12px] font-semibold disabled:opacity-40">{t('addBtn')}</button>
                        </div>
                        <div className="rounded-xl border border-subtle p-3 space-y-1 text-[12px]">
                          <div className="flex justify-between"><span className="text-secondary">{t('loanAmount')}</span><span className="font-mono text-primary">{fmtCents(total)}</span></div>
                          <div className="flex justify-between"><span className="text-secondary">{t('loanPaid')}</span><span className="font-mono text-notion-green">− {fmtCents(repaid)}</span></div>
                          <div className="flex justify-between"><span className="text-secondary">{t('loanPlan')}</span><span className="font-mono text-primary">− {fmtCents(planned)}</span></div>
                          <div className="flex justify-between border-t border-subtle pt-1 font-semibold">
                            <span className="text-primary">{t('loanRemaining')}</span>
                            <span className={`font-mono ${Math.abs(gap) < 0.01 ? 'text-notion-green' : 'text-notion-red'}`}>{Math.abs(gap) < 0.01 ? t('loanPlannedOk') : fmtCents(gap)}</span>
                          </div>
                          {Math.abs(gap) >= 0.01 && <p className="text-[11px] text-secondary">{t('loanPlannedGap')}</p>}
                        </div>
                      </>
                    )}
                  </div>
                )}
                <button onClick={() => setLoanEdit(null)} className="w-full py-2 bg-primary text-surface font-semibold rounded-lg text-xs">{t('closeBtn')}</button>
              </Modal>
            );
          })()}

          {/* LOAN MODAL */}
          {loanModal && loanForm && (
            <Modal size="max-w-md" onClose={() => setLoanModal(null)} title={<><span>⚡</span><span>{t('loanModalTitle')}</span></>}>
              <p className="text-secondary text-[11px] leading-relaxed">{t('loanModalDesc')}</p>
              {(() => {
                const amount = parseFloat(loanForm.incomeAmount) || 0;
                const earlier = (data.ious || []).find(i => !i.settled && i.type === 'borrowed' && Math.abs((parseFloat(i.amount) || 0) - amount) < 0.01);
                if (!earlier) return null;
                return (
                  <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
                    ⚠️ {t('loanDuplicateWarn', { amount: fmt(amount), person: earlier.person, date: earlier.date })}
                    <button type="button" onClick={() => { setLoanModal(null); setLoanAddPos(''); setLoanEdit(earlier.id); }}
                      className="block mt-2 font-semibold underline underline-offset-2">✎ {t('loanEditExisting')}</button>
                  </div>
                );
              })()}

              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 space-y-2">
                <span className="font-semibold text-notion-green block">{t('loanStep1', { month: formatMonth(selectedMonth, lang), year: selectedYear })}</span>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-secondary font-medium block mb-1">{t('loanLenderLabel')}</label>
                    <input
                      type="text"
                      value={loanForm.lender}
                      onChange={(e) => setLoanForm(p => ({ ...p, lender: e.target.value }))}
                      className="w-full bg-surface border border-subtle rounded px-2.5 py-1.5 text-primary outline-none font-medium"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-secondary font-medium block mb-1">{t('loanReceivedAmountLabel')}</label>
                    <MoneyInput
                      value={loanForm.incomeAmount}
                      hideZero={false}
                      onChange={(val) => setLoanForm(p => ({ ...p, incomeAmount: val }))}
                      className="bg-surface py-1.5"
                      inputClass="text-notion-green font-bold"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-secondary block mb-0.5">{t('loanIncomeCatLabel')}</label>
                  <input
                    type="text"
                    value={loanForm.incomeName}
                    onChange={(e) => setLoanForm(p => ({ ...p, incomeName: e.target.value }))}
                    className="w-full bg-surface border border-subtle rounded px-2.5 py-1 text-primary text-[11px] outline-none"
                  />
                </div>
              </div>

              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 space-y-2">
                <span className="font-semibold text-notion-red block">{t('loanStep2')}</span>
                <div>
                  <label className="text-[10px] text-secondary block mb-0.5">{t('loanExpenseCatLabel')}</label>
                  <input
                    type="text"
                    value={loanForm.expenseName}
                    onChange={(e) => setLoanForm(p => ({ ...p, expenseName: e.target.value }))}
                    className="w-full bg-surface border border-subtle rounded px-2.5 py-1 text-primary text-[11px] outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {[['m1', 'a1', 'loanInst1Month'], ['m2', 'a2', 'loanInst2Month']].map(([mKey, aKey, label]) => (
                    <div key={mKey}>
                      <label className="text-[10px] text-secondary block mb-1">{t(label)}</label>
                      <select
                        value={loanForm[mKey]}
                        onChange={(e) => setLoanForm(p => ({ ...p, [mKey]: e.target.value }))}
                        className="w-full bg-surface border border-subtle rounded px-2 py-1 text-primary outline-none"
                      >
                        {loanMonthOptions.map(({ yr, m }) => (
                          <option key={`${yr}|${m}`} value={`${yr}|${m}`}>{formatMonth(m, lang)} {yr}</option>
                        ))}
                      </select>
                      <MoneyInput
                        value={loanForm[aKey]}
                        hideZero={false}
                        onChange={(val) => setLoanForm(p => ({ ...p, [aKey]: val }))}
                        className="bg-surface mt-1"
                        inputClass="text-notion-red font-bold"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 pt-2 border-t border-subtle">
                <button onClick={() => setLoanModal(null)} className="flex-1 py-2 bg-subtle text-secondary rounded hover:text-primary">
                  {t('cancelBtn')}
                </button>
                <button onClick={handleExecuteLoanBooking} className="flex-1 py-2 bg-primary text-surface font-semibold rounded">
                  {t('loanConfirmBtn')}
                </button>
              </div>
            </Modal>
          )}

          {/* QUICK ADD MODAL */}
          {quickAddModal && (
            <Modal onClose={() => setQuickAddModal(null)} title={t('quickAddModalTitle')}>
              <div>
                <label className="text-[10px] text-secondary font-medium block mb-1">{t('posten')}</label>
                <input
                  type="text"
                  value={quickAddForm.name}
                  list="merchant-list"
                  onChange={(e) => setQuickAddForm(p => ({ ...p, name: e.target.value }))}
                  placeholder={t('quickAddNamePlaceholder')}
                  autoFocus
                  className="w-full bg-subtle border border-subtle rounded px-2.5 py-1.5 text-primary outline-none focus:border-strong font-medium"
                />
              </div>

              {(() => {
                const isExpense = quickAddModal.type === 'expenses';
                const group = isExpense ? (data.groups.find(g => g.id === quickAddForm.bracket) || data.groups[0]) : null;
                const lockedOnce = isExpense && group.kind === 'oneoff';
                const once = quickAddForm.isOneTime || lockedOnce;
                const needsAmount = !(isExpense && group.kind === 'variable' && !once);
                return (
                  <>
                    <div>
                      <label className="text-[10px] text-secondary font-medium block mb-1">{t('howOften')}</label>
                      <div className="grid grid-cols-2 gap-1 bg-subtle p-0.5 rounded border border-subtle">
                        {[[false, t('recurringLabel')], [true, t('badgeOneTime')]].map(([value, label]) => (
                          <button
                            key={label}
                            type="button"
                            disabled={lockedOnce && !value}
                            aria-pressed={once === value}
                            onClick={() => setQuickAddForm(p => ({ ...p, isOneTime: value }))}
                            className={`py-1.5 rounded text-[11px] disabled:opacity-40 ${once === value ? 'bg-surface text-primary font-semibold shadow-sm' : 'text-secondary'}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="text-[10px] text-tertiary mt-1">{once ? t('onceHelp') : t('recurringHelp')}</p>
                    </div>

                    <div>
                      <label className="text-[10px] text-secondary font-medium block mb-1">{isExpense ? t('groupLabel') : t('bracketLabel')}</label>
                      <select
                        value={quickAddForm.bracket}
                        onChange={(e) => {
                          const next = e.target.value;
                          const nextKind = isExpense ? data.groups.find(g => g.id === next)?.kind : null;
                          setQuickAddForm(p => ({ ...p, bracket: next, isOneTime: nextKind === 'oneoff' ? true : p.isOneTime }));
                        }}
                        className="w-full bg-subtle border border-subtle rounded px-2 py-1.5 text-primary outline-none"
                      >
                        {isExpense
                          ? data.groups.map(g => <option key={g.id} value={g.id}>{groupName(g)} · {kindLabel(g.kind)}</option>)
                          : data.brackets.incomes.map(b => <option key={b.id} value={b.id}>{t('brackets.' + b.id)}</option>)}
                      </select>
                      {isExpense && !once && <p className="text-[10px] text-tertiary mt-1">{t('groupKindHelp_' + group.kind)}</p>}
                    </div>

                    {needsAmount ? (
                      <>
                        <div>
                          <label className="text-[10px] text-secondary font-medium block mb-1">{t('initialBudgetLabel')}</label>
                          <MoneyInput
                            value={quickAddForm.budget}
                            onChange={(val) => setQuickAddForm(p => ({ ...p, budget: val }))}
                            className="py-1.5"
                          />
                        </div>
                        {renderPeriod(
                          quickAddForm.from,
                          quickAddForm.until,
                          (key, value) => setQuickAddForm(p => ({ ...p, [key]: value })),
                          once,
                          once ? null : quickAddForm.every
                        )}
                      </>
                    ) : (
                      <p className="text-[11px] text-secondary p-2 rounded bg-subtle/50 border border-subtle">{t('variableItemHelp')}</p>
                    )}

                    {!isExpense && (
                      <div>
                        <label className="text-[10px] text-secondary font-medium block mb-1">{t('modeLabel')}</label>
                        <div className="grid grid-cols-2 gap-1 bg-subtle p-0.5 rounded border border-subtle">
                          {['fixed', 'variable'].map(m => (
                            <button
                              key={m}
                              type="button"
                              onClick={() => setQuickAddForm(p => ({ ...p, mode: m }))}
                              className={`py-1 rounded text-[11px] ${quickAddForm.mode === m ? 'bg-surface text-primary font-semibold shadow-sm' : 'text-secondary'}`}
                            >
                              {m === 'fixed' ? t('badgeFixed') : t('badgeVariable')}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}

              <div className="flex gap-2 pt-2 border-t border-subtle">
                <button onClick={() => setQuickAddModal(null)} className="flex-1 py-1.5 bg-subtle text-secondary rounded hover:text-primary">
                  {t('cancelBtn')}
                </button>
                <button
                  disabled={!quickAddForm.name.trim()}
                  onClick={() => handleCreateCategory(
                    quickAddModal.type,
                    quickAddForm.name,
                    quickAddForm.bracket,
                    quickAddForm.mode,
                    quickAddForm.budget,
                    quickAddForm.isOneTime,
                    quickAddForm.from,
                    quickAddForm.until,
                    parseInt(quickAddForm.every) || 1
                  )}
                  className="flex-1 py-1.5 bg-primary text-surface font-semibold rounded disabled:opacity-40"
                >
                  {t('addItemBtn')}
                </button>
              </div>
            </Modal>
          )}

          {/* EDIT MODAL */}
          {activeEditCat && (
            <Modal onClose={() => setActiveEditCat(null)} title={t('editorTitle')}>
              {(() => {
                const { type: et, cat: ec } = activeEditCat;
                const tint = tintFor(et, ec);
                const g = et === 'expenses' ? data.groups.find(x => x.id === getMeta('expenses', ec).bracket) : null;
                const n = getNode(et, ec, selectedYear, selectedMonth);
                return (
                  <div className="rounded-2xl p-3 flex items-center gap-3" style={{ background: tint + '1f', border: `1px solid ${tint}55` }}>
                    <ItemIcon spec={iconFor(et, ec)} tint={tint} size={40} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-semibold text-primary truncate">{ec}</div>
                      <div className="text-[11px] truncate" style={{ color: tint }}>{g ? groupName(g) : t('incomesHeader')} · {formatMonth(selectedMonth, lang)} {selectedYear}</div>
                    </div>
                    <div className="text-end shrink-0">
                      <div className="text-[10px] text-secondary">{t('planLabel')}</div>
                      <div className="font-mono text-[14px] font-semibold text-primary">{fmtCents(n.budget)}</div>
                    </div>
                  </div>
                );
              })()}
              <div className="space-y-3">
              <div>
                <label className="text-[10px] text-secondary font-medium block mb-1">{t('posten')}</label>
                <input
                  type="text"
                  value={editCatForm.name}
                  onChange={(e) => setEditCatForm(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full bg-subtle border border-subtle rounded px-2.5 py-1.5 text-primary outline-none focus:border-strong font-medium"
                />
              </div>

              <div>
                <label className="text-[10px] text-secondary font-medium block mb-1">{t('iconLabel')}</label>
                <div className="flex items-center gap-2 mb-2">
                  <ItemIcon spec={data.icons[activeEditCat.cat] || autoIcon(editCatForm.name) || iconFor(activeEditCat.type, activeEditCat.cat)} tint={tintFor(activeEditCat.type, activeEditCat.cat)} size={36} />
                  <button type="button" onClick={() => setItemIcon(activeEditCat.cat, null)} aria-pressed={!data.icons[activeEditCat.cat]}
                    className={`h-8 px-3 rounded-lg text-[11px] font-medium border ${!data.icons[activeEditCat.cat] ? 'border-primary text-primary' : 'border-subtle text-secondary'}`}>{t('iconAuto')}</button>
                  <button type="button" disabled={iconBusy} onClick={() => suggestIcons([activeEditCat.cat])}
                    className="h-8 px-3 rounded-lg text-[11px] font-medium border border-subtle text-secondary hover:text-primary disabled:opacity-50">
                    {iconBusy ? t('askThinking') : `✨ ${t('iconAi')}`}
                  </button>
                </div>
                {(() => {
                  const q = iconQuery.trim() || editCatForm.name;
                  const opts = logoOptions(q);
                  const cur = data.icons[activeEditCat.cat];
                  return (
                    <div className="mb-2 space-y-1.5">
                      <div className="relative flex items-center">
                        <i className="fa-solid fa-magnifying-glass absolute text-[11px] text-tertiary pointer-events-none" style={{ insetInlineStart: 12 }}></i>
                        <input data-free type="search" value={iconQuery} onChange={(e) => setIconQuery(e.target.value)} placeholder={t('logoSearch')}
                          style={{ paddingInlineStart: 32 }} className="w-full bg-subtle border border-subtle rounded-xl pe-3 py-2 text-[12.5px] text-primary outline-none focus:border-notion-blue" />
                      </div>
                      {opts.length > 0 ? (
                        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
                          {opts.map(o => {
                            const sel = !!cur && cur.kind === 'brand' && (cur.logo ? cur.logo === o.spec.logo : cur.text === o.spec.text && cur.bg === o.spec.bg);
                            return (
                              <button key={o.label + (o.spec.logo || '')} type="button" onClick={() => setItemIcon(activeEditCat.cat, o.spec)} aria-pressed={sel}
                                className={`shrink-0 w-16 flex flex-col items-center gap-1 rounded-xl py-1.5 border ${sel ? 'border-notion-blue bg-notion-blue/10' : 'border-transparent hover:bg-subtle'}`}>
                                <ItemIcon spec={o.spec} size={32} />
                                <span className="text-[10px] text-secondary w-full truncate px-1 text-center">{o.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      ) : iconQuery.trim().length >= 2 && <p className="text-[11px] text-tertiary">{t('logoNone')}</p>}
                    </div>
                  );
                })()}
                <div className="grid grid-cols-8 gap-1 max-h-[132px] overflow-y-auto pe-1">
                  {ICON_CHOICES.map(ic => {
                    const sel = data.icons[activeEditCat.cat]?.icon === ic;
                    return (
                      <button key={ic} type="button" onClick={() => setItemIcon(activeEditCat.cat, { kind: 'symbol', icon: ic })} aria-label={ic.replace('fa-', '')} aria-pressed={sel}
                        className={`h-8 rounded-lg flex items-center justify-center text-[13px] ${sel ? 'bg-primary text-surface' : 'bg-subtle text-secondary hover:text-primary'}`}>
                        <i className={`fa-solid ${ic}`}></i>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="text-[10px] text-secondary font-medium block mb-1">
                  {activeEditCat.type === 'expenses' ? t('groupLabel') : t('bracketLabel')}
                </label>
                <select
                  value={editCatForm.bracket}
                  onChange={(e) => setEditCatForm(prev => ({ ...prev, bracket: e.target.value }))}
                  className="w-full bg-subtle border border-subtle rounded px-2 py-1.5 text-primary outline-none"
                >
                  {activeEditCat.type === 'expenses'
                    ? data.groups.map(g => <option key={g.id} value={g.id}>{groupName(g)} · {kindLabel(g.kind)}</option>)
                    : data.brackets.incomes.map(b => <option key={b.id} value={b.id}>{t('brackets.' + b.id)}</option>)}
                </select>
              </div>

              {!editIsShop && <div className="grid grid-cols-3 gap-2">
                {activeEditCat.type === 'incomes' ? (
                <div className="col-span-2">
                  <label className="text-[10px] text-secondary font-medium block mb-1">{t('modeLabel')}</label>
                  <div className="grid grid-cols-2 gap-1 bg-subtle p-0.5 rounded border border-subtle">
                    {['fixed', 'variable'].map(m => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setEditCatForm(prev => ({ ...prev, mode: m }))}
                        className={`py-1 rounded text-[11px] ${editCatForm.mode === m ? 'bg-surface text-primary font-semibold shadow-sm' : 'text-secondary'}`}
                      >
                        {m === 'fixed' ? t('badgeFixed') : t('badgeVariable')}
                      </button>
                    ))}
                  </div>
                </div>
                ) : <div className="col-span-2"></div>}
                <div>
                  <label className="text-[10px] text-secondary font-medium block mb-1">{t('paymentDayShort')}</label>
                  <input
                    type="number" inputMode="numeric" min="1" max="31"
                    value={editCatForm.pDay}
                    onChange={(e) => setEditCatForm(prev => ({ ...prev, pDay: e.target.value }))}
                    className="w-full bg-subtle border border-subtle rounded px-2 py-1 text-primary outline-none text-center font-mono"
                  />
                </div>
              </div>}

              {!editIsShop && (() => {
                const lockedOnce = activeEditCat.type === 'expenses' &&
                  data.groups.find(g => g.id === editCatForm.bracket)?.kind === 'oneoff';
                return (
                  <label className="flex items-center justify-between gap-2 p-2 rounded bg-subtle border border-subtle cursor-pointer">
                    <div>
                      <span className="font-medium text-primary block">{t('badgeOneTime')}</span>
                      <span className="text-[10px] text-secondary">{t('onceHelp')}</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={editCatForm.isOneTime || lockedOnce}
                      disabled={lockedOnce}
                      onChange={(e) => setEditCatForm(prev => ({ ...prev, isOneTime: e.target.checked }))}
                      className="w-4 h-4 rounded shrink-0"
                    />
                  </label>
                );
              })()}

              <div className="space-y-1.5 pt-2 border-t border-subtle">
                <div className="text-[10px] text-secondary font-medium flex items-center justify-between">
                  <span>{t('notesTitleMonth', { month: formatMonth(selectedMonth, lang), year: selectedYear })}</span>
                  <span>({editCatForm.notes.length})</span>
                </div>

                <div className="space-y-1 max-h-24 overflow-y-auto">
                  {editCatForm.notes.map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between p-1.5 rounded bg-subtle text-xs gap-2">
                      <span className="text-primary truncate">{item}</span>
                      <button onClick={() => handleRemoveBulletPoint(idx)} aria-label={t('deleteCategoryBtn')} className="text-tertiary hover:text-notion-red">
                        <i className="fa-solid fa-xmark"></i>
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex gap-1.5">
                  <input
                    type="text"
                    placeholder={t('addNotePlaceholder')}
                    value={newBulletText}
                    onChange={(e) => setNewBulletText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddBulletPoint(); }}
                    className="flex-1 bg-subtle border border-subtle rounded px-2 py-1 text-xs text-primary outline-none"
                  />
                  <button onClick={handleAddBulletPoint} className="bg-subtle hover:bg-subtle/80 px-2.5 py-1 rounded text-primary font-medium">
                    +
                  </button>
                </div>
              </div>

              {!editIsShop && (
                <div className="rounded-2xl bg-subtle/60 p-3 space-y-3">
                  <div className="text-[12px] font-semibold text-primary"><i className="fa-solid fa-repeat me-1.5 text-[10px] text-secondary"></i>{t('edPlanCard')}</div>
                  {recurringForm.sch && (() => {
                    const sc = recurringForm.sch;
                    const lbl = (i) => `${formatMonth(TIMELINE[i].m, lang)} ${TIMELINE[i].yr}`;
                    return (
                      <div className="rounded-xl bg-surface/70 px-3 py-2 text-[12px] text-secondary leading-relaxed">
                        <span className="text-primary font-medium">{t('schNow')}</span>{' '}
                        {t('schFrom', { month: lbl(sc.fromIdx) })}
                        {sc.firstDiffers && <> · {t('schFirst', { amount: fmtCents(sc.first) })}</>}
                        {' · '}{t(sc.every === 1 ? 'schEveryMonth' : 'schEveryN', { amount: fmtCents(sc.regular), n: sc.every })}
                        {' · '}{sc.openEnd ? t('schOpenEnd') : t('schUntil', { month: lbl(sc.lastIdx) })}
                        {sc.odd > 0 && <span className="block text-[11px] text-tertiary">{t('schOdd', { n: sc.odd })}</span>}
                      </div>
                    );
                  })()}
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-[11px] text-primary">{t('pmToggle')}</span>
                <input type="checkbox" checked={!!recurringForm.perMonthOn} onChange={(e) => setRecurringForm(p => ({ ...p, perMonthOn: e.target.checked, firstOn: false, perMonth: p.perMonth || {}, dirty: true }))} className="w-4 h-4 rounded" />
              </label>
              {!recurringForm.perMonthOn && <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-[11px] text-primary">{t('schFirstToggle')}</span>
                <input type="checkbox" checked={!!recurringForm.firstOn} onChange={(e) => setRecurringForm(p => ({ ...p, firstOn: e.target.checked, firstAmount: p.firstAmount === '' ? p.amount : p.firstAmount, dirty: true }))} className="w-4 h-4 rounded" />
              </label>}
              {recurringForm.firstOn && (
                <div>
                  <label className="text-[10px] text-secondary font-medium block mb-1">{t('schFirstLabel')}</label>
                  <MoneyInput value={recurringForm.firstAmount} hideZero={false} onChange={(val) => setRecurringForm(p => ({ ...p, firstAmount: val, dirty: true }))} inputClass="text-primary font-semibold" />
                </div>
              )}
              <div>
                <label className="text-[10px] text-secondary font-medium block mb-1">{recurringForm.perMonthOn ? t('pmDefault') : recurringForm.firstOn ? t('schThenLabel') : t('replicateAmountLabel')}</label>
                <MoneyInput
                  value={recurringForm.amount}
                  hideZero={false}
                  onChange={(val) => setRecurringForm(p => ({ ...p, amount: val, dirty: true }))}
                  inputClass="text-primary font-semibold"
                />
              </div>

              {renderPeriod(
                recurringForm.from,
                recurringForm.until,
                (key, value) => setRecurringForm(p => ({ ...p, [key]: value, dirty: true })),
                false,
                recurringForm.every
              )}
              {recurringForm.perMonthOn && activeEditCat && (() => {
                const { type, cat } = activeEditCat;
                const [a, b] = rangeIndexes(recurringForm.from, recurringForm.until);
                const every = parseInt(recurringForm.every) || 1;
                const months = TIMELINE.slice(a, b + 1).filter((_, i) => i % every === 0);
                const paidMonths = months.filter(({ yr, m }) => getNode(type, cat, yr, m).actual > 0);
                const total = months.reduce((sum, { yr, m }) => sum + perMonthValue(recurringForm, type, cat, yr, m), 0);
                const setOne = (k, v) => setRecurringForm(p => ({ ...p, perMonth: { ...(p.perMonth || {}), [k]: v }, dirty: true }));
                return (
                  <div className="pop-in space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-secondary font-medium">{t('pmList', { n: months.length, total: fmtCents(total) })}</span>
                      {paidMonths.length > 0 && (
                        <button type="button" onClick={() => setRecurringForm(p => ({ ...p, dirty: true, perMonth: { ...(p.perMonth || {}),
                          ...Object.fromEntries(paidMonths.map(({ yr, m }) => [timelineKey(yr, m), String(Math.round(getNode(type, cat, yr, m).actual * 100) / 100)])) } }))}
                          className="text-[11px] text-notion-blue font-medium">{t('pmUsePaid', { n: paidMonths.length })}</button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 max-h-[260px] overflow-y-auto pe-1">
                      {months.map(({ yr, m }) => {
                        const k = timelineKey(yr, m);
                        const own = recurringForm.perMonth && recurringForm.perMonth[k] != null;
                        const v = own ? recurringForm.perMonth[k] : String(perMonthValue(recurringForm, type, cat, yr, m));
                        const act = getNode(type, cat, yr, m).actual;
                        return (
                          <label key={k} className="flex items-center gap-1.5 rounded-lg bg-surface border border-subtle px-2 py-1">
                            <span className="text-[11px] text-secondary shrink-0 w-[58px]">{formatMonth(m, lang)} {String(yr).slice(2)}{act > 0 && <i className="fa-solid fa-check text-notion-green text-[9px] ms-1"></i>}</span>
                            <input value={v} onChange={(e) => setOne(k, e.target.value)} inputMode="decimal"
                              style={{ flex: '1 1 0', minWidth: 0, width: 'auto' }}
                              className={`bg-transparent text-end font-mono text-[12px] outline-none ${own ? 'text-primary font-semibold' : 'text-secondary'}`} />
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-tertiary">{t('pmHint')}</p>
                  </div>
                );
              })()}

              {recurringForm.field === 'budget' && (
                <label className="flex items-start justify-between gap-2 p-2 rounded bg-subtle/50 border border-subtle cursor-pointer">
                  <div>
                    <span className="font-medium text-primary block text-[11px]">{t('clearOutside')}</span>
                    <span className="text-[10px] text-tertiary">{t('clearOutsideHint')}</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={recurringForm.clearOutside}
                    onChange={(e) => setRecurringForm(p => ({ ...p, clearOutside: e.target.checked, dirty: true }))}
                    className="w-4 h-4 rounded mt-0.5 shrink-0"
                  />
                </label>
              )}

                </div>
              )}

              {data.categories[activeEditCat.type].length > 1 && (
                <label className="flex items-center gap-2 rounded-xl bg-subtle/60 px-3 py-2">
                  <i className="fa-solid fa-object-group text-[12px] text-secondary"></i>
                  <span className="text-[12px] text-primary shrink-0">{t('mergeLabel')}</span>
                  <select data-free value="" onChange={(e) => {
                      const to = e.target.value; const { type, cat } = activeEditCat;
                      if (to && window.confirm(t('mergeConfirm', { from: cat, to }))) { mergeItems(type, cat, to); setActiveEditCat(null); }
                    }}
                    className="flex-1 min-w-0 bg-surface border border-subtle rounded-lg px-2 py-1.5 text-[12px] text-primary">
                    <option value="">{t('mergePick')}</option>
                    {data.categories[activeEditCat.type].filter(c => c !== activeEditCat.cat).map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              )}
              <div className="pt-2 border-t border-subtle">
                <button onClick={() => { if (!editIsShop && recurringForm.dirty) handleExecuteRecurring(); handleSaveCategoryChanges(); }} className="w-full bg-primary text-surface font-semibold py-2 rounded-xl">
                  {t('saveClose')}
                </button>
              </div>
              </div>
            </Modal>
          )}

          {/* REPLICATE RECURRING MODAL */}
          {recurringModal && (
            <Modal onClose={() => setRecurringModal(null)} title={<><i className="fa-solid fa-repeat"></i><span>{t('replicateTitle')}</span></>}>
              <div className="p-2 rounded bg-subtle">
                <span className="text-secondary text-[10px] block">{t('replicateCatLabel')}</span>
                <span className="font-semibold text-primary">{recurringModal.cat}</span>
              </div>

              <div>
                <label className="text-[10px] text-secondary font-medium block mb-1">{t('replicateFieldLabel')}</label>
                <div className="grid grid-cols-2 gap-2">
                  {[['budget', 'replicateBudgetOption']].map(([field, label]) => (
                    <button
                      key={field}
                      type="button"
                      onClick={() => setRecurringForm(p => ({ ...p, field }))}
                      className={`p-1.5 rounded border text-xs ${recurringForm.field === field ? 'border-primary bg-subtle font-semibold text-primary' : 'border-subtle text-secondary'}`}
                    >
                      {t(label)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[10px] text-secondary font-medium block mb-1">{t('replicateAmountLabel')}</label>
                <MoneyInput
                  value={recurringForm.amount}
                  hideZero={false}
                  onChange={(val) => setRecurringForm(p => ({ ...p, amount: val }))}
                  inputClass="text-primary font-semibold"
                />
              </div>

              {renderPeriod(
                recurringForm.from,
                recurringForm.until,
                (key, value) => setRecurringForm(p => ({ ...p, [key]: value })),
                false,
                recurringForm.every
              )}

              {recurringForm.field === 'budget' && (
                <label className="flex items-start justify-between gap-2 p-2 rounded bg-subtle/50 border border-subtle cursor-pointer">
                  <div>
                    <span className="font-medium text-primary block text-[11px]">{t('clearOutside')}</span>
                    <span className="text-[10px] text-tertiary">{t('clearOutsideHint')}</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={recurringForm.clearOutside}
                    onChange={(e) => setRecurringForm(p => ({ ...p, clearOutside: e.target.checked }))}
                    className="w-4 h-4 rounded mt-0.5 shrink-0"
                  />
                </label>
              )}

              <div className="flex gap-2 pt-2 border-t border-subtle">
                <button onClick={() => setRecurringModal(null)} className="flex-1 py-1.5 bg-subtle text-secondary rounded hover:text-primary">
                  {t('cancelBtn')}
                </button>
                <button onClick={handleExecuteRecurring} className="flex-1 py-1.5 bg-primary text-surface font-semibold rounded">
                  {t('replicateActionBtn')}
                </button>
              </div>
            </Modal>
          )}

          {/* SMART DELETE MODAL */}
          {smartDeleteModal && (() => {
            const { type, cat } = smartDeleteModal;
            const fallback = findFallback(type);
            const isFallback = fallback === cat;
            return (
              <Modal onClose={() => setSmartDeleteModal(null)} titleClass="text-notion-red" title={t('deleteItemTitle', { name: cat })}>
                <div className="space-y-1.5">
                  <button
                    onClick={() => executeSmartDelete(type, cat, 'future_only')}
                    className="w-full text-start p-2 rounded bg-subtle hover:bg-subtle/80 border border-subtle"
                  >
                    <div className="font-semibold text-primary">{t('deleteFutureOnly')}</div>
                    <div className="text-[10px] text-tertiary">{t('deleteFutureOnlyDesc')}</div>
                  </button>

                  {isFallback ? (
                    <p className="p-2 rounded border border-subtle text-[11px] text-secondary">
                      {t('deleteFallbackBlocked', { name: cat })}
                    </p>
                  ) : (
                    <button
                      onClick={() => executeSmartDelete(type, cat, 'purge_and_merge')}
                      className="w-full text-start p-2 rounded bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20"
                    >
                      <div className="font-semibold text-notion-red">{t('deletePurgeMerge', { fallback })}</div>
                      <div className="text-[10px] text-tertiary">{t('deletePurgeMergeDesc')}</div>
                    </button>
                  )}
                </div>

                <button onClick={() => setSmartDeleteModal(null)} className="w-full py-1.5 bg-subtle rounded text-secondary hover:text-primary">
                  {t('cancelBtn')}
                </button>
              </Modal>
            );
          })()}

          {/* SETTINGS DRAWER */}
          {isBurgerOpen && (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-end" onClick={(e) => { if (e.target === e.currentTarget) setIsBurgerOpen(false); }}>
              <div className="bg-surface border-s border-subtle w-72 sm:w-80 h-full p-4 overflow-y-auto flex flex-col justify-between text-xs">
                <div className="space-y-4">
                  <div className="flex justify-between items-center pb-2 border-b border-subtle">
                    <h3 className="font-semibold text-primary uppercase tracking-wide">{t('options')}</h3>
                    <button onClick={() => setIsBurgerOpen(false)} aria-label={t('closeBtn')} className="text-secondary hover:text-primary">
                      <i className="fa-solid fa-xmark"></i>
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] text-secondary block">{t('cloudSync')}</label>
                    {user ? (
                      <div className="p-2 rounded border border-subtle bg-subtle/50 space-y-2">
                        <div className="flex items-center gap-2">
                          <i className={`fa-solid ${syncIcon} ${syncStatus === 'error' ? 'text-notion-red' : 'text-notion-green'}`}></i>
                          <div className="min-w-0">
                            <div className="text-primary font-medium truncate">{t('signedInAs', { email: user.email || user.uid })}</div>
                            <div className="text-[10px] text-tertiary">{t('syncStatus_' + syncStatus)}</div>
                          </div>
                        </div>
                        <button onClick={handleSignOut} className="w-full py-1 rounded border border-subtle text-secondary hover:text-primary">
                          {t('signOut')}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <p className="text-[10px] text-tertiary">{t('syncLocalOnly')}</p>
                        <button
                          onClick={handleSignIn}
                          className="w-full bg-primary text-surface font-semibold py-1.5 rounded flex items-center justify-center gap-1.5"
                        >
                          <i className="fa-brands fa-google"></i> {t('signIn')}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] text-secondary block">{t('householdLabel')}</label>
                    {households.length > 1 && (
                      <div className="space-y-1">
                        {households.map(h => (
                          <button key={h.id} onClick={() => switchHousehold(h.id)} aria-pressed={h.id === householdId}
                            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded border text-start ${h.id === householdId ? 'border-strong bg-subtle text-primary font-semibold' : 'border-subtle text-secondary hover:text-primary'}`}>
                            <i className={`fa-solid ${h.exists ? 'fa-house' : 'fa-plus'} text-[10px] w-3`}></i>
                            <span className="flex-1 truncate">{h.id === householdId ? (data.name || (h.id === HOUSEHOLD_IDS[0] ? t('title') : t('householdUnnamed'))) : h.exists ? (h.name || (h.id === HOUSEHOLD_IDS[0] ? t('title') : t('householdUnnamed'))) : t('householdNew')}</span>
                            {h.id === householdId && <i className="fa-solid fa-check text-[10px]"></i>}
                          </button>
                        ))}
                      </div>
                    )}
                    <input value={data.name} onChange={(e) => { const v = e.target.value; mutate(d => { d.name = v.slice(0, 60); }); }}
                      placeholder={t('title')} aria-label={t('householdLabel')}
                      className="w-full bg-subtle border border-subtle rounded px-2 py-1.5 text-primary outline-none focus:border-strong" />
                  </div>

                  <div className="space-y-1.5">
                    <button onClick={applyStarterKit} title={t('starterHint')} className="w-full py-1.5 rounded border border-dashed border-strong text-secondary hover:text-primary">
                      <i className="fa-solid fa-children me-1.5"></i>{t('starterBtn')}
                    </button>
                    <p className="text-[10px] text-tertiary">{t('starterHint')}</p>
                    <label className="text-[10px] text-secondary block">{t('membersLabel')}</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {['me', 'partner'].map(w => (
                        <input
                          key={w}
                          value={data.members[w]}
                          onChange={(e) => { const v = e.target.value; mutate(d => { d.members[w] = v; }); }}
                          aria-label={t('membersLabel')}
                          className="min-w-0 bg-subtle border border-subtle rounded px-2 py-1.5 text-primary outline-none focus:border-strong"
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] text-secondary block">{t('startingCapital')}</label>
                    <MoneyInput
                      value={data.startingCapital || 0}
                      onChange={(val) => mutate(d => { d.startingCapital = parseFloat(val) || 0; })}
                      className="py-1.5"
                      inputClass="text-primary font-semibold"
                    />
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-secondary shrink-0">{t('startingMonthLabel')}</span>
                      <select
                        value={data.startingMonth}
                        onChange={(e) => mutate(d => { d.startingMonth = e.target.value; })}
                        className="flex-1 min-w-0 bg-subtle border border-subtle rounded px-2 py-1 text-primary outline-none"
                      >
                        {TIMELINE.map(({ yr, m }) => (
                          <option key={timelineKey(yr, m)} value={timelineKey(yr, m)}>{formatMonth(m, lang)} {yr}</option>
                        ))}
                      </select>
                    </div>
                    <p className="text-[10px] text-tertiary leading-snug">{t('startingHint')}</p>
                  </div>

                  <div>
                    <label className="text-[10px] text-secondary block mb-1">{t('themeLabel')}</label>
                    <div className="grid grid-cols-3 gap-1 bg-subtle p-0.5 rounded border border-subtle">
                      {['light', 'dark', 'system'].map(m => (
                        <button key={m} onClick={() => setTheme(m)} className={`py-1 rounded text-[10px] font-medium ${theme === m ? 'bg-surface text-primary shadow-sm font-semibold' : 'text-secondary'}`}>
                          {t(`theme${m.charAt(0).toUpperCase() + m.slice(1)}`)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] text-secondary block mb-1">{t('motionLabel')}</label>
                    <div className="grid grid-cols-2 gap-1 bg-subtle p-0.5 rounded border border-subtle">
                      {['on', 'off'].map(m => (
                        <button key={m} onClick={() => setMotion(m)} className={`py-1 rounded text-[10px] font-medium ${motion === m ? 'bg-surface text-primary shadow-sm font-semibold' : 'text-secondary'}`}>
                          {t(m === 'on' ? 'motionOn' : 'motionOff')}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] text-secondary block mb-1">{t('labsTitle')}</label>
                    {[['nowToday', 'labsNowToday'], ['reminders', 'labsReminders'], ['importAmount', 'labsImportAmount'], ['closeMonth', 'labsCloseMonth'], ['splitUp', 'labsSplitUp']].map(([k, lbl]) => (
                      <label key={k} className="flex items-center justify-between gap-2 rounded bg-subtle/60 px-2 py-1.5 cursor-pointer">
                        <span className="text-[11px] text-primary">{t(lbl)}</span>
                        <input type="checkbox" checked={!!labs[k]} onChange={(e) => setLab(k, e.target.checked)} className="w-4 h-4" />
                      </label>
                    ))}
                  </div>

                  <div className="space-y-1.5 pt-2 border-t border-subtle">
                    <label className="text-[10px] text-secondary block mb-1">{t('backupSection')}</label>
                    <button
                      onClick={() => { setIsBurgerOpen(false); openImport(); }}
                      className="w-full bg-primary text-surface font-semibold py-1.5 rounded flex items-center justify-center gap-1.5"
                    >
                      ⬇ {t('importTitle')}
                    </button>
                    <button
                      onClick={() => {
                        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `budget_backup_${new Date().toISOString().slice(0, 10)}.json`;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      }}
                      className="w-full bg-subtle hover:bg-subtle/80 border border-subtle font-medium py-1.5 rounded flex items-center justify-center gap-1.5 text-primary"
                    >
                      <i className="fa-solid fa-download"></i> {t('exportBackup')}
                    </button>

                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full bg-subtle hover:bg-subtle/80 border border-subtle font-medium py-1.5 rounded flex items-center justify-center gap-1.5 text-primary"
                    >
                      <i className="fa-solid fa-upload"></i> {t('importBackup')}
                    </button>
                    <input
                      ref={fileInputRef} type="file" accept=".json,application/json"
                      onChange={(e) => {
                        const f = e.target.files[0];
                        e.target.value = "";
                        if (!f) return;
                        const r = new FileReader();
                        r.onload = (ev) => {
                          try {
                            replaceState(normalizeState(JSON.parse(ev.target.result)));
                            alert(t('importSuccess'));
                            setIsBurgerOpen(false);
                          } catch(err) { alert(t('importError')); }
                        };
                        r.readAsText(f);
                      }}
                      className="hidden"
                    />
                  </div>

                  <div className="space-y-1 pt-2 border-t border-subtle">
                    <label className="text-[10px] text-secondary block">{t('autoBackups')}</label>
                    {backups.length === 0 ? (
                      <p className="text-[10px] text-tertiary">{t('autoBackupsEmpty')}</p>
                    ) : backups.map(b => (
                      <div key={b.day} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-mono text-secondary">{b.day.split('-').reverse().join('.')}</span>
                        <button
                          onClick={() => {
                            if (!confirm(t('autoBackupConfirm', { day: b.day.split('-').reverse().join('.') }))) return;
                            undoRef.current = dataRef.current;
                            replaceState(normalizeState(b.data));
                            setIsBurgerOpen(false);
                            showToast(t('autoBackupRestored'), true);
                          }}
                          className="text-notion-blue hover:underline"
                        >
                          {t('autoBackupRestore')}
                        </button>
                      </div>
                    ))}
                    <p className="text-[10px] text-tertiary">{t('autoBackupsHint')}</p>
                  </div>
                </div>

                <div className="pt-3 border-t border-subtle">
                  <button
                    onClick={() => {
                      if (confirm(t('confirmClear'))) {
                        replaceState(activeHousehold === HOUSEHOLD_IDS[0] ? normalizeState(null) : freshHousehold());
                        setIsBurgerOpen(false);
                      }
                    }}
                    className="text-xs text-notion-red underline text-center"
                  >
                    {t('clearAll')}
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>
      );
    }

    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<LanguageProvider><MainApp /></LanguageProvider>);
