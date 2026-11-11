/*!
 * cs-lead-form.js v0.2.0 · lead form
 *
 * Aprimora todo form[data-cs-form] da página (modos "steps" e "single"): validação, máscara de
 * telefone, foco gerenciado, eventos cs:* em document e envio JSON para o lead.php (mesma origem).
 * Script clássico (IIFE), ES2020, zero dependências. Ordem de carga (defer):
 *   cs-config.js → cs-track.js → cs-lead-form.js → site.js
 *
 * PII (name, email, phone) sai SÓ no corpo do POST e em cs:lead.detail.user_data. Nenhum valor de
 * campo vai para console, storage, URL ou para os outros eventos.
 * Com CS_CONFIG.preview === true (cópia estática, sem servidor): valida tudo e mostra o passo done com um
 * aviso, sem enviar nada, sem cs:lead e sem redirect.
 * Em Node (testes) só as funções puras são exportadas; nada de DOM é tocado.
 */
/* global window, document, sessionStorage, CustomEvent, crypto */
(function () {
  'use strict';

  // ── Constantes do contrato ────────────────────────────────────────────────
  const VERSION = '0.2.0';
  const PREVIEW_MESSAGE = 'Preview: nothing was sent.';
  const SUBMIT_TIMEOUT_MS = 10000; // falha de rede ou timeout (10 s)
  const REDIRECT_DELAY_MS = 350; // redireciona após ~350 ms (tempo para o tracking disparar)
  const DEFAULT_ENDPOINT = '/api/lead.php';
  const LEAD_STORAGE_KEY = 'cs_lead_tracked';
  const HONEYPOT_FIELD = 'company_website';
  const VALIDATED_FIELDS = ['zip', 'service', 'details', 'name', 'phone', 'email'];
  const PAYLOAD_FIELDS = ['zip', 'service', 'details', 'name', 'phone', 'email', 'sms_consent'];
  const STEP_NAMES = { 1: 'zip', 2: 'service', 3: 'contact' };
  const NAME_MIN = 2;
  const NAME_MAX = 100;
  const EMAIL_MAX = 254;
  const DETAILS_MAX = 1000;
  const LEAD_ID_MAX = 200;
  const FIELD_NAME_MAX = 64;
  const ZIP_RE = /^\d{5}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const FALLBACK_FAILURE_TEXT = 'Something went wrong. Please try again.';
  const ANNOUNCE_DELAY_MS = 60; // região viva precisa ser esvaziada antes para repetir o mesmo texto
  const POINTER_ACTION_WINDOW_MS = 1000; // janela entre pointerdown num botão de ação e o click
  const ACTION_SELECTOR = '[data-cs-next], [data-cs-back], [type="submit"]';
  const DOCUMENT_POSITION_FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING

  // ── Funções puras (testadas em tests/construction-site-factory/lead-form/) ──

  function toStr(value) {
    return value == null ? '' : String(value);
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function charLength(text) {
    return Array.from(text).length;
  }

  function digitsOnly(value) {
    return toStr(value).replace(/\D/g, '');
  }

  /**
   * Telefone US normalizado em 10 dígitos, ou null.
   * Um "1" inicial é tratado como código do país (DDD dos EUA nunca começa com 1),
   * então "+1 (404) 750-2787" e "14047502787" viram "4047502787".
   */
  function normalizePhone(value) {
    let digits = digitsOnly(value);
    if (digits.charAt(0) === '1') digits = digits.slice(1);
    return digits.length === 10 ? digits : null;
  }

  /** Máscara progressiva "(xxx) xxx-xxxx"; com "+1 " na frente quando o usuário digita o código do país. */
  function formatPhone(value) {
    let digits = digitsOnly(value);
    let prefix = '';
    if (digits.charAt(0) === '1') {
      prefix = '+1';
      digits = digits.slice(1);
    }
    digits = digits.slice(0, 10);
    let body = digits;
    if (digits.length > 6) body = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    else if (digits.length > 3) body = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    if (!prefix) return body;
    return body ? `${prefix} ${body}` : prefix;
  }

  /** ZIP: só dígitos, no máximo 5. */
  function sanitizeZip(value) {
    return digitsOnly(value).slice(0, 5);
  }

  /**
   * Regras de validação (o servidor revalida tudo).
   * @returns {null|'required'|'invalid'} null = válido
   */
  function validateField(name, value) {
    const text = toStr(value).trim();
    switch (name) {
      case 'zip':
        if (!text) return 'required';
        return ZIP_RE.test(text) ? null : 'invalid';
      case 'service':
        return text ? null : 'required';
      case 'name': {
        if (!text) return 'required';
        const length = charLength(text);
        return length >= NAME_MIN && length <= NAME_MAX ? null : 'invalid';
      }
      case 'phone':
        return normalizePhone(text) ? null : 'invalid';
      case 'email':
        return text.length <= EMAIL_MAX && EMAIL_RE.test(text) ? null : 'invalid';
      case 'details':
        return charLength(text) <= DETAILS_MAX ? null : 'invalid';
      default:
        return null; // sms_consent é opcional; o honeypot nunca é validado no front
    }
  }

  /** Lista de ZIPs da área: strings de 5 dígitos; números perdem o zero à esquerda e são completados. */
  function normalizeZipList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    list.forEach((item) => {
      let zip = '';
      if (typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 99999) {
        zip = String(item).padStart(5, '0');
      } else if (typeof item === 'string' && ZIP_RE.test(item.trim())) {
        zip = item.trim();
      }
      if (zip && out.indexOf(zip) === -1) out.push(zip);
    });
    return out;
  }

  /** Fora da área só quando a lista não está vazia e o ZIP (válido) não está nela. */
  function isOutOfArea(zip, zips) {
    const value = toStr(zip).trim();
    const list = normalizeZipList(zips);
    return ZIP_RE.test(value) && list.length > 0 && list.indexOf(value) === -1;
  }

  /** URL de mesma origem (caminho + query [+ hash]) ou null. Bloqueia destino de outra origem. */
  function resolveSameOrigin(candidate, pageHref, keepHash) {
    const raw = toStr(candidate).trim();
    if (!raw) return null;
    try {
      const base = new URL(pageHref);
      const url = new URL(raw, base);
      if (url.protocol !== base.protocol || url.origin !== base.origin) return null;
      return url.pathname + url.search + (keepHash ? url.hash : '');
    } catch (_error) {
      return null;
    }
  }

  /** Endpoint do lead: CS_CONFIG.lead.endpoint → action do form → /api/lead.php (sempre mesma origem). */
  function resolveEndpoint(candidate, pageHref) {
    return resolveSameOrigin(candidate, pageHref, false) || DEFAULT_ENDPOINT;
  }

  /** Lê o subconjunto de window.CS_CONFIG que o form usa. Config ausente/inválida → defaults. */
  function resolveSettings(config, formAction, pageHref) {
    const cfg = isPlainObject(config) ? config : {};
    const lead = isPlainObject(cfg.lead) ? cfg.lead : {};
    const area = isPlainObject(cfg.serviceArea) ? cfg.serviceArea : {};
    const version = typeof lead.smsConsentVersion === 'string' ? lead.smsConsentVersion.trim() : '';
    return {
      endpoint: resolveSameOrigin(lead.endpoint, pageHref, false) || resolveEndpoint(formAction, pageHref),
      redirect: resolveSameOrigin(lead.redirect, pageHref, true),
      smsConsentVersion: version || null,
      zips: normalizeZipList(area.zips),
      outOfArea: area.outOfArea === 'block' ? 'block' : 'accept-with-message',
      preview: cfg.preview === true,
    };
  }

  function stepName(step) {
    return STEP_NAMES[step] || `step_${step}`;
  }

  /** UUID v4: crypto.randomUUID() → getRandomValues → Math.random (último recurso). */
  function generateEventId(cryptoImpl = typeof crypto !== 'undefined' ? crypto : null) {
    if (cryptoImpl && typeof cryptoImpl.randomUUID === 'function') {
      try {
        return cryptoImpl.randomUUID();
      } catch (_error) {
        // randomUUID exige contexto seguro; cai para getRandomValues
      }
    }
    const bytes = new Uint8Array(16);
    if (cryptoImpl && typeof cryptoImpl.getRandomValues === 'function') {
      cryptoImpl.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // versão 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** Atribuição como objeto JSON simples; qualquer outra coisa (ou erro) → {}. */
  function sanitizeAttribution(value) {
    if (!isPlainObject(value)) return {};
    try {
      const copy = JSON.parse(JSON.stringify(value));
      return isPlainObject(copy) ? copy : {};
    } catch (_error) {
      return {};
    }
  }

  /** window.csTrack?.getAttribution() quando o tracking existe; senão {}. */
  function readAttribution(scope) {
    try {
      const tracker = scope ? scope.csTrack : null;
      return sanitizeAttribution(tracker?.getAttribution?.());
    } catch (_error) {
      return {};
    }
  }

  function stripHash(href) {
    return toStr(href).split('#')[0];
  }

  function toTimestamp(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }

  /**
   * Corpo do POST, campo a campo.
   * @param {object} input { formId, values, hasSmsField, smsConsentVersion, pageUrl, referrer,
   *                         eventId, attribution, startedAt, clientTs }
   */
  function buildPayload(input) {
    const data = isPlainObject(input) ? input : {};
    const values = isPlainObject(data.values) ? data.values : {};
    const phone = toStr(values.phone).trim();
    const sms = values.sms_consent === 'yes' || values.sms_consent === 'no' ? values.sms_consent : null;
    return {
      form_id: toStr(data.formId),
      zip: toStr(values.zip).trim(),
      service: toStr(values.service).trim(),
      details: toStr(values.details).trim(),
      name: toStr(values.name).trim(),
      phone: normalizePhone(phone) || digitsOnly(phone),
      email: toStr(values.email).trim(),
      sms_consent: data.hasSmsField ? sms : null,
      sms_consent_text_version: data.hasSmsField ? toStr(data.smsConsentVersion).trim() || null : null,
      page_url: toStr(data.pageUrl),
      referrer: toStr(data.referrer),
      event_id: toStr(data.eventId),
      attribution: sanitizeAttribution(data.attribution),
      company_website: toStr(values[HONEYPOT_FIELD]),
      started_at: toTimestamp(data.startedAt),
      client_ts: toTimestamp(data.clientTs),
    };
  }

  function normalizeLeadId(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return null;
    const id = value.trim();
    return id && id.length <= LEAD_ID_MAX ? id : null;
  }

  /** Só campos do contrato; o honeypot e chaves desconhecidas nunca viram erro visível. */
  function pickFieldErrors(errors) {
    const picked = {};
    if (!isPlainObject(errors)) return picked;
    PAYLOAD_FIELDS.forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(errors, field)) return;
      const code = errors[field];
      if (code == null || code === false) return;
      picked[field] = toStr(code) || 'invalid';
    });
    return picked;
  }

  function networkFailure() {
    return { action: 'error', reason: 'network', message: 'network' };
  }

  /**
   * Resposta HTTP → ação do front.
   * action: 'success' (emite cs:lead) | 'success_silent' (ok sem lead_id: honeypot; não emite)
   *         | 'field_errors' | 'error'. reason segue cs:form_submit_error.
   */
  function mapResponse(status, body) {
    const data = isPlainObject(body) ? body : {};
    if (status >= 200 && status < 300) {
      if (data.ok !== true) return { action: 'error', reason: 'server', message: 'server' };
      const leadId = normalizeLeadId(data.lead_id);
      return leadId ? { action: 'success', leadId } : { action: 'success_silent', leadId: null };
    }
    if (status === 422) {
      const errors = pickFieldErrors(data.errors);
      return Object.keys(errors).length
        ? { action: 'field_errors', reason: 'validation', errors }
        : { action: 'error', reason: 'validation', message: 'server' };
    }
    if (status === 429) return { action: 'error', reason: 'rate_limited', message: 'rate' };
    return { action: 'error', reason: 'server', message: 'server' }; // 400/405/413/415/5xx/outros
  }

  /**
   * POST JSON com timeout. Nunca rejeita: devolve sempre o resultado de mapResponse/networkFailure.
   * @param {object} options { fetchImpl, endpoint, payload, timeoutMs }
   */
  function sendLead(options) {
    const opts = isPlainObject(options) ? options : {};
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : SUBMIT_TIMEOUT_MS;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;

    const request = Promise.resolve()
      .then(async () => {
        const response = await opts.fetchImpl(opts.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(opts.payload),
          credentials: 'same-origin',
          signal: controller ? controller.signal : undefined,
        });
        let body = null;
        try {
          body = JSON.parse(await response.text());
        } catch (_error) {
          body = null;
        }
        return mapResponse(response.status, body);
      })
      .catch(() => networkFailure());

    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        resolve(networkFailure());
      }, timeoutMs);
    });

    return Promise.race([request, timeout]).then((result) => {
      clearTimeout(timer);
      return result;
    });
  }

  /** redirect + '?lead=' + id (ou '&lead=' se já houver query), preservando o hash. */
  function buildRedirectUrl(redirect, leadId) {
    const base = toStr(redirect);
    if (!leadId) return base;
    const hashAt = base.indexOf('#');
    const path = hashAt === -1 ? base : base.slice(0, hashAt);
    const hash = hashAt === -1 ? '' : base.slice(hashAt);
    const separator = path.indexOf('?') === -1 ? '?' : '&';
    return `${path}${separator}lead=${encodeURIComponent(String(leadId))}${hash}`;
  }

  /** Texto da falha: data-cs-msg-{network|server|rate} do form, com fallback entre eles. */
  function resolveFailureMessage(kind, messages) {
    const source = isPlainObject(messages) ? messages : {};
    const pick = (keys) => {
      for (const key of keys) {
        const text = toStr(source[key]).trim();
        if (text) return text;
      }
      return FALLBACK_FAILURE_TEXT;
    };
    if (kind === 'network') return pick(['network', 'server', 'fallback']);
    if (kind === 'rate') return pick(['rate', 'server', 'fallback']);
    return pick(['server', 'network', 'fallback']);
  }

  function shouldEmitAbandon(meta) {
    return Boolean(meta && meta.started && !meta.leadDone && !meta.abandonSent && !meta.submitting);
  }

  /** Detalhe do cs:form_abandon: só metadados, nunca valores. */
  function buildAbandonDetail(meta, now) {
    const startedAt = Number(meta && meta.startedAt) || 0;
    return {
      form_id: toStr(meta && meta.formId),
      last_step: meta && meta.lastStep != null ? meta.lastStep : null,
      last_field: meta && meta.lastField ? toStr(meta.lastField) : null,
      seconds: startedAt ? Math.max(0, Math.round((Number(now) - startedAt) / 1000)) : 0,
    };
  }

  const api = {
    VERSION,
    SUBMIT_TIMEOUT_MS,
    REDIRECT_DELAY_MS,
    DEFAULT_ENDPOINT,
    LEAD_STORAGE_KEY,
    HONEYPOT_FIELD,
    STEP_NAMES,
    digitsOnly,
    normalizePhone,
    formatPhone,
    sanitizeZip,
    validateField,
    normalizeZipList,
    isOutOfArea,
    resolveSameOrigin,
    resolveEndpoint,
    resolveSettings,
    stepName,
    generateEventId,
    sanitizeAttribution,
    readAttribution,
    stripHash,
    buildPayload,
    normalizeLeadId,
    pickFieldErrors,
    networkFailure,
    mapResponse,
    sendLead,
    buildRedirectUrl,
    resolveFailureMessage,
    shouldEmitAbandon,
    buildAbandonDetail,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ── Navegador ─────────────────────────────────────────────────────────────

  const controllers = [];
  const enhanced = new WeakSet();
  let idSeq = 0;

  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(`cs:${name}`, { detail }));
  }

  function uniqueId(prefix) {
    let id = '';
    do {
      idSeq += 1;
      id = `${prefix}-${idSeq}`;
    } while (document.getElementById(id));
    return id;
  }

  function ensureId(el, prefix) {
    if (!el.id) el.id = uniqueId(prefix);
    return el.id;
  }

  function safeToken(value) {
    return toStr(value).replace(/[^A-Za-z0-9_-]/g, '-');
  }

  /** Liga/desliga um id numa lista de tokens (aria-describedby) sem apagar os da página. */
  function setToken(el, attr, token, on) {
    const tokens = toStr(el.getAttribute(attr)).split(/\s+/).filter((t) => t && t !== token);
    if (on) tokens.push(token);
    if (tokens.length) el.setAttribute(attr, tokens.join(' '));
    else el.removeAttribute(attr);
  }

  function focusElement(el, preventScroll) {
    if (!el || typeof el.focus !== 'function') return;
    try {
      el.focus({ preventScroll: Boolean(preventScroll) });
    } catch (_error) {
      el.focus();
    }
    if (preventScroll && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) el.scrollIntoView({ block: 'center' });
    }
  }

  function byDomOrder(a, b) {
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function stepNumber(el) {
    return parseInt(el.getAttribute('data-cs-step'), 10);
  }

  function createController(form) {
    const formId = form.getAttribute('data-cs-form') || form.id || 'lead-form';
    const idPrefix = `cs-${safeToken(formId)}`;
    const stepEls = Array.from(form.querySelectorAll('[data-cs-step]'))
      .filter((el) => /^\d+$/.test(el.getAttribute('data-cs-step')))
      .sort((a, b) => stepNumber(a) - stepNumber(b));
    const doneEl = form.querySelector('[data-cs-step="done"]');
    const mode = form.getAttribute('data-cs-mode') !== 'single' && stepEls.length > 1 ? 'steps' : 'single';
    const totalSteps = mode === 'steps' ? stepEls.length : 1;
    const firstStep = mode === 'steps' ? stepNumber(stepEls[0]) : 1;
    const lastStep = mode === 'steps' ? stepNumber(stepEls[stepEls.length - 1]) : 1;
    const liveEl = form.querySelector('[data-cs-live]');
    const statusEl = form.querySelector('[data-cs-status]');
    const areaEl = form.querySelector('[data-cs-out-of-area]');
    const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
    const statusFallback = statusEl ? statusEl.textContent.trim() : '';
    const meta = {
      formId,
      initAt: Date.now(),
      started: false,
      startedAt: 0,
      lastStep: firstStep,
      lastField: null,
      submitting: false,
      leadDone: false,
      abandonSent: false,
    };
    const shownErrors = {};
    const completedSteps = new Set();
    const reportedOutOfArea = new Set(); // ZIPs só em memória, para emitir o evento uma vez por ZIP
    let announcedOutOfArea = '';
    let currentStep = firstStep;
    let eventId = null; // um por lead: reenvios após falha reusam o mesmo id (dedupe no servidor)
    let savedButton = null;
    let redirectTimer = null;
    let announceTimer = null;
    let statusTimer = null;
    let pointerOnAction = false;
    let pointerTimer = null;

    const currentSettings = () => resolveSettings(window.CS_CONFIG, form.getAttribute('action'), window.location.href);
    const fieldEls = (name) => Array.from(form.querySelectorAll(`[name="${name}"]`));
    const hasField = (name) => fieldEls(name).length > 0;
    const errorEl = (name) => form.querySelector(`[data-cs-error-for="${name}"]`);

    function fieldValue(name) {
      const els = fieldEls(name);
      if (!els.length) return '';
      if (els[0].type === 'radio' || els[0].type === 'checkbox') {
        const checked = els.find((el) => el.checked);
        return checked ? checked.value : '';
      }
      return els[0].value;
    }

    function stepOfElement(el) {
      if (mode !== 'steps' || !el) return firstStep;
      const host = el.closest('[data-cs-step]');
      const n = host ? stepNumber(host) : NaN;
      return Number.isFinite(n) ? n : firstStep;
    }

    const stepOfField = (name) => stepOfElement(fieldEls(name)[0]);
    const fieldInStep = (name, step) => hasField(name) && (mode !== 'steps' || stepOfField(name) === step);

    function announce(text) {
      if (!liveEl || !text) return;
      clearTimeout(announceTimer);
      liveEl.textContent = '';
      announceTimer = setTimeout(() => {
        liveEl.textContent = text;
      }, ANNOUNCE_DELAY_MS);
    }

    function markStarted() {
      if (meta.started) return;
      meta.started = true;
      meta.startedAt = Date.now();
      emit('form_start', { form_id: formId });
    }

    function noteField(name) {
      if (name && name !== HONEYPOT_FIELD) meta.lastField = toStr(name).slice(0, FIELD_NAME_MAX);
    }

    // ── Erros de campo ──
    function showError(name, code, announceIt) {
      const err = errorEl(name);
      fieldEls(name).forEach((el) => {
        el.setAttribute('aria-invalid', 'true');
        if (err) setToken(el, 'aria-describedby', err.id, true);
      });
      if (err) err.hidden = false;
      if (shownErrors[name] !== code) {
        shownErrors[name] = code;
        emit('form_error', { form_id: formId, step: stepOfField(name), field: name, error: code });
      }
      if (announceIt && err) announce(err.textContent.trim());
    }

    function clearError(name) {
      const err = errorEl(name);
      fieldEls(name).forEach((el) => {
        el.removeAttribute('aria-invalid');
        if (err) setToken(el, 'aria-describedby', err.id, false);
      });
      if (err) err.hidden = true;
      delete shownErrors[name];
    }

    /** context: 'input' (só limpa erro já visível) | 'blur' (mostra e anuncia) | 'commit' (avançar/enviar). */
    function checkField(name, context) {
      if (!hasField(name)) return true;
      const code = validateField(name, fieldValue(name));
      if (!code) {
        if (shownErrors[name] !== undefined) clearError(name);
        return true;
      }
      if (context !== 'input') showError(name, code, context === 'blur');
      return false;
    }

    /** Valida todos (mostra todos os erros) e devolve o primeiro inválido na ordem do DOM. */
    function validateFields(names) {
      const invalid = names.filter((name) => !checkField(name, 'commit'));
      if (!invalid.length) return null;
      return invalid
        .map((name) => ({ name, el: fieldEls(name)[0] }))
        .sort((a, b) => byDomOrder(a.el, b.el))[0].name;
    }

    function focusField(name) {
      const els = fieldEls(name);
      focusElement(els.find((el) => el.checked) || els[0], false);
    }

    function revealField(name) {
      const step = stepOfField(name);
      if (mode === 'steps' && step !== currentStep) showStep(step, { focus: false, announce: true });
      focusField(name);
    }

    // ── Fora da área ──
    function checkArea() {
      if (!hasField('zip')) return false;
      const zip = fieldValue('zip').trim();
      const out = isOutOfArea(zip, currentSettings().zips);
      if (areaEl) {
        areaEl.hidden = !out;
        const areaId = ensureId(areaEl, `${idPrefix}-out-of-area`);
        fieldEls('zip').forEach((el) => setToken(el, 'aria-describedby', areaId, out));
        if (out && announcedOutOfArea !== zip) {
          announcedOutOfArea = zip;
          announce(areaEl.textContent.trim());
        }
      }
      if (!out) announcedOutOfArea = '';
      if (out && !reportedOutOfArea.has(zip)) {
        reportedOutOfArea.add(zip);
        emit('form_zip_out_of_area', { form_id: formId });
      }
      return out;
    }

    const blockedByArea = () => checkArea() && currentSettings().outOfArea === 'block';

    // ── Passos e progresso ──
    function renderProgress(step) {
      const done = step === 'done';
      form.querySelectorAll('[data-cs-stepper-item]').forEach((el) => {
        const n = parseInt(el.getAttribute('data-cs-stepper-item'), 10);
        el.classList.toggle('is-done', done || n < step);
        if (!done && n === step) el.setAttribute('aria-current', 'step');
        else el.removeAttribute('aria-current');
      });
      form.querySelectorAll('[data-cs-rail]').forEach((el) => {
        const n = parseInt(el.getAttribute('data-cs-rail'), 10);
        el.classList.toggle('is-filled', done || n < step);
      });
    }

    function focusStepStart(stepEl) {
      if (!stepEl) return;
      const fields = Array.from(stepEl.querySelectorAll('input, select, textarea')).filter(
        (el) => el.name !== HONEYPOT_FIELD && el.type !== 'hidden' && !el.disabled && el.getAttribute('tabindex') !== '-1',
      );
      let target = fields[0];
      if (target && target.type === 'radio') {
        target = fields.find((el) => el.name === target.name && el.checked) || target;
      }
      if (!target) {
        target = stepEl.querySelector('h1, h2, h3, h4, h5, h6') || stepEl;
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      }
      focusElement(target, true);
    }

    function showStep(step, options) {
      const opts = options || {};
      currentStep = step;
      meta.lastStep = step;
      stepEls.forEach((el) => {
        el.hidden = stepNumber(el) !== step;
      });
      if (doneEl) doneEl.hidden = true;
      renderProgress(step);
      if (opts.announce) announce(`Step ${stepEls.findIndex((el) => stepNumber(el) === step) + 1} of ${totalSteps}`);
      if (opts.focus) focusStepStart(stepEls.find((el) => stepNumber(el) === step));
    }

    function completeStep(step) {
      if (mode !== 'steps' || completedSteps.has(step)) return;
      completedSteps.add(step);
      emit('form_step', { form_id: formId, step, step_name: stepName(step) });
    }

    function showDone() {
      stepEls.forEach((el) => {
        el.hidden = true;
      });
      renderProgress('done');
      hideStatus();
      clearTimeout(announceTimer);
      if (liveEl) liveEl.textContent = '';
      if (!doneEl) return;
      doneEl.hidden = false;
      const target = doneEl.querySelector('h1, h2, h3, h4, h5, h6') || doneEl;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      focusElement(target, true);
    }

    /** Passo done da prévia: o mesmo sucesso, com o aviso de que nada foi enviado. */
    function showPreviewDone() {
      const text = toStr(form.getAttribute('data-cs-msg-preview')).trim() || PREVIEW_MESSAGE;
      showDone();
      if (!doneEl) {
        announce(text);
        return;
      }
      let note = doneEl.querySelector('[data-cs-preview-note]');
      if (!note) {
        note = document.createElement('p');
        note.className = 'cs-preview-note';
        note.setAttribute('data-cs-preview-note', '');
        doneEl.appendChild(note);
      }
      note.textContent = text;
    }

    // ── Status de envio e estado ocupado ──
    function hideStatus() {
      clearTimeout(statusTimer);
      if (!statusEl) return;
      statusEl.hidden = true;
      statusEl.textContent = '';
    }

    function showStatus(kind) {
      const text = resolveFailureMessage(kind, {
        network: form.getAttribute('data-cs-msg-network'),
        server: form.getAttribute('data-cs-msg-server'),
        rate: form.getAttribute('data-cs-msg-rate'),
        fallback: statusFallback,
      });
      if (!statusEl) {
        announce(text);
        return;
      }
      clearTimeout(statusTimer);
      statusEl.textContent = '';
      statusEl.hidden = false;
      // role="alert" anuncia mudança de conteúdo: o texto entra depois de a região estar visível
      statusTimer = setTimeout(() => {
        statusEl.textContent = text;
      }, ANNOUNCE_DELAY_MS);
    }

    function setBusy(busy) {
      meta.submitting = busy;
      if (busy) form.setAttribute('aria-busy', 'true');
      else form.removeAttribute('aria-busy');
      if (!submitBtn) return;
      submitBtn.disabled = busy;
      const label = submitBtn.getAttribute('data-cs-loading-label');
      if (busy && label && savedButton === null) {
        if (submitBtn.tagName === 'INPUT') {
          savedButton = submitBtn.value;
          submitBtn.value = label;
        } else {
          savedButton = Array.from(submitBtn.childNodes);
          submitBtn.textContent = label;
        }
      } else if (!busy && savedButton !== null) {
        if (submitBtn.tagName === 'INPUT') submitBtn.value = savedButton;
        else submitBtn.replaceChildren(...savedButton);
        savedButton = null;
      }
    }

    // ── Navegação ──
    function goNext() {
      if (meta.submitting || meta.leadDone || mode !== 'steps') return;
      if (currentStep >= lastStep) {
        attemptSubmit();
        return;
      }
      markStarted();
      const invalid = validateFields(VALIDATED_FIELDS.filter((name) => fieldInStep(name, currentStep)));
      if (invalid) {
        focusField(invalid);
        return;
      }
      if (fieldInStep('zip', currentStep) && blockedByArea()) {
        focusField('zip');
        return;
      }
      completeStep(currentStep);
      const index = stepEls.findIndex((el) => stepNumber(el) === currentStep);
      showStep(stepNumber(stepEls[index + 1]), { focus: true, announce: true });
    }

    function goBack() {
      if (meta.submitting || meta.leadDone || mode !== 'steps') return;
      const index = stepEls.findIndex((el) => stepNumber(el) === currentStep);
      if (index <= 0) return;
      hideStatus();
      showStep(stepNumber(stepEls[index - 1]), { focus: true, announce: true });
    }

    // ── Envio ──
    function attemptSubmit() {
      if (meta.submitting || meta.leadDone) return;
      markStarted();
      if (mode === 'steps' && currentStep < lastStep) {
        goNext();
        return;
      }
      const invalid = validateFields(VALIDATED_FIELDS.filter(hasField));
      if (invalid) {
        revealField(invalid);
        return;
      }
      if (blockedByArea()) {
        revealField('zip');
        return;
      }
      completeStep(currentStep);
      emit('form_submit', { form_id: formId });

      const settings = currentSettings();
      if (settings.preview) {
        meta.leadDone = true;
        showPreviewDone();
        return;
      }
      if (!eventId) eventId = generateEventId();
      const values = {};
      PAYLOAD_FIELDS.concat(HONEYPOT_FIELD).forEach((name) => {
        values[name] = fieldValue(name);
      });
      const payload = buildPayload({
        formId,
        values,
        hasSmsField: hasField('sms_consent'),
        smsConsentVersion: settings.smsConsentVersion,
        pageUrl: stripHash(window.location.href),
        referrer: document.referrer,
        eventId,
        attribution: readAttribution(window),
        startedAt: meta.startedAt || meta.initAt,
        clientTs: Date.now(),
      });

      hideStatus();
      setBusy(true);
      sendLead({
        fetchImpl: (url, init) => window.fetch(url, init),
        endpoint: settings.endpoint,
        payload,
        timeoutMs: SUBMIT_TIMEOUT_MS,
      }).then((result) => handleResult(result, payload, settings));
    }

    function handleResult(result, payload, settings) {
      if (result.action === 'success' || result.action === 'success_silent') {
        meta.leadDone = true;
        meta.submitting = false;
        form.removeAttribute('aria-busy');
        if (result.action === 'success') {
          emit('lead', {
            form_id: formId,
            lead_id: result.leadId,
            event_id: payload.event_id,
            service: payload.service,
            user_data: { email: payload.email, phone: payload.phone },
          });
          try {
            sessionStorage.setItem(LEAD_STORAGE_KEY, result.leadId);
          } catch (_error) {
            // storage bloqueado: o backup da thank-you deduplica pelo lead_id
          }
        }
        if (settings.redirect) {
          // botão segue desabilitado ("Sending…") até a navegação: sem segundo envio
          redirectTimer = setTimeout(() => {
            window.location.assign(buildRedirectUrl(settings.redirect, result.leadId));
          }, REDIRECT_DELAY_MS);
        } else {
          showDone();
        }
        return;
      }

      setBusy(false);
      emit('form_submit_error', { form_id: formId, reason: result.reason });
      if (result.action === 'field_errors') {
        const names = Object.keys(result.errors).filter(hasField);
        if (names.length) {
          names.forEach((name) => showError(name, result.errors[name], false));
          const first = names.map((name) => ({ name, el: fieldEls(name)[0] })).sort((a, b) => byDomOrder(a.el, b.el))[0];
          revealField(first.name);
          return;
        }
      }
      showStatus(result.message || 'server');
      const active = document.activeElement;
      if (submitBtn && (!active || active === document.body || active === submitBtn)) focusElement(submitBtn, true);
    }

    // ── Listeners ──
    function applyMask(field, formatter) {
      const raw = field.value;
      const next = formatter(raw);
      if (next === raw) return;
      const focused = document.activeElement === field;
      const caret = focused && typeof field.selectionStart === 'number' ? field.selectionStart : raw.length;
      const digitsBefore = digitsOnly(raw.slice(0, caret)).length;
      field.value = next;
      if (!focused) return;
      // recoloca o cursor depois do mesmo número de dígitos (editar no meio não pula para o fim)
      let pos = 0;
      let seen = 0;
      while (pos < next.length && seen < digitsBefore) {
        if (/\d/.test(next.charAt(pos))) seen += 1;
        pos += 1;
      }
      try {
        field.setSelectionRange(pos, pos);
      } catch (_error) {
        // tipo de input sem API de seleção
      }
    }

    function fieldFromEvent(event) {
      const field = event.target;
      if (!field || !field.name || field.name === HONEYPOT_FIELD || !form.contains(field)) return null;
      return field;
    }

    function onInput(event) {
      const field = fieldFromEvent(event);
      if (!field) return;
      markStarted();
      noteField(field.name);
      if (field.name === 'phone') applyMask(field, formatPhone);
      if (field.name === 'zip') {
        applyMask(field, sanitizeZip);
        checkArea();
      }
      if (VALIDATED_FIELDS.indexOf(field.name) !== -1) checkField(field.name, 'input');
    }

    function onChange(event) {
      const field = fieldFromEvent(event);
      if (!field || (field.type !== 'radio' && field.type !== 'checkbox' && field.tagName !== 'SELECT')) return;
      markStarted();
      noteField(field.name);
      if (field.name === 'sms_consent' && field.type === 'checkbox' && field.checked) {
        // par Sim/Não em checkboxes: mantém exclusão mútua
        fieldEls('sms_consent').forEach((el) => {
          if (el !== field) el.checked = false;
        });
      }
      if (VALIDATED_FIELDS.indexOf(field.name) !== -1) checkField(field.name, 'blur');
    }

    function onFocusIn(event) {
      const field = fieldFromEvent(event);
      if (field) noteField(field.name);
    }

    function onPointerDown(event) {
      const target = event.target;
      pointerOnAction = Boolean(target && typeof target.closest === 'function' && target.closest(ACTION_SELECTOR));
      clearTimeout(pointerTimer);
      if (pointerOnAction) {
        pointerTimer = setTimeout(() => {
          pointerOnAction = false;
        }, POINTER_ACTION_WINDOW_MS);
      }
    }

    function onFocusOut(event) {
      const field = fieldFromEvent(event);
      if (!field || VALIDATED_FIELDS.indexOf(field.name) === -1) return;
      if (field.type === 'radio' || field.type === 'checkbox' || meta.leadDone) return;
      if (!toStr(field.value).trim()) return; // valida ao sair só se preenchido
      // Clique em Next/Back/Enviar: um erro que aparecesse agora empurraria o botão entre o
      // mousedown e o mouseup e o clique se perderia. A validação do próprio clique cobre.
      if (pointerOnAction) return;
      const to = event.relatedTarget;
      const toAction = to && form.contains(to) && to.closest(ACTION_SELECTOR);
      // Tab até Next/Enviar: o erro aparece, mas o anúncio fica com o foco no 1º inválido
      checkField(field.name, toAction ? 'commit' : 'blur');
    }

    function onClick(event) {
      pointerOnAction = false;
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const next = target.closest('[data-cs-next]');
      if (next && form.contains(next)) {
        event.preventDefault();
        goNext();
        return;
      }
      const back = target.closest('[data-cs-back]');
      if (back && form.contains(back)) {
        event.preventDefault();
        goBack();
      }
    }

    function onKeyDown(event) {
      if (event.key !== 'Enter' || event.isComposing || mode !== 'steps') return;
      const field = event.target;
      if (!field || field.tagName !== 'INPUT' || !form.contains(field)) return;
      if (['button', 'submit', 'reset', 'file', 'image'].indexOf(field.type) !== -1) return;
      if (currentStep >= lastStep) return; // último passo: submissão implícita nativa → onSubmit
      event.preventDefault();
      goNext();
    }

    function onSubmit(event) {
      event.preventDefault();
      attemptSubmit();
    }

    function maybeAbandon() {
      if (!shouldEmitAbandon(meta)) return;
      meta.abandonSent = true;
      emit('form_abandon', buildAbandonDetail(meta, Date.now()));
    }

    function onPageShow(event) {
      // Voltou pelo histórico (bfcache) depois do redirect: libera o form em vez de deixá-lo travado.
      if (!event.persisted || !meta.leadDone || !redirectTimer) return;
      redirectTimer = null;
      meta.leadDone = false;
      meta.abandonSent = true; // o lead já foi enviado; sair agora não é abandono
      eventId = null; // um novo envio é um novo lead
      setBusy(false);
    }

    // ── Init ──
    form.noValidate = true;
    form.querySelectorAll('[data-cs-error-for]').forEach((el) => {
      ensureId(el, `${idPrefix}-${safeToken(el.getAttribute('data-cs-error-for'))}-error`);
    });
    if (mode === 'steps') showStep(firstStep, { focus: false, announce: false });
    form.addEventListener('input', onInput);
    form.addEventListener('change', onChange);
    form.addEventListener('focusin', onFocusIn);
    form.addEventListener('pointerdown', onPointerDown);
    form.addEventListener('focusout', onFocusOut);
    form.addEventListener('click', onClick);
    form.addEventListener('keydown', onKeyDown);
    form.addEventListener('submit', onSubmit);

    return { maybeAbandon, onPageShow };
  }

  function init() {
    document.querySelectorAll('form[data-cs-form]').forEach((form) => {
      if (enhanced.has(form)) return;
      enhanced.add(form);
      try {
        controllers.push(createController(form));
      } catch (error) {
        // sem PII aqui: só o id do form e a mensagem técnica
        console.warn('[cs-lead-form] form not enhanced:', form.getAttribute('data-cs-form'), error && error.message);
      }
    });
  }

  const abandonAll = () => controllers.forEach((controller) => controller.maybeAbandon());
  window.addEventListener('pagehide', abandonAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') abandonAll();
  });
  window.addEventListener('pageshow', (event) => controllers.forEach((controller) => controller.onPageShow(event)));

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
