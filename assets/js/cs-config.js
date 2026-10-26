/* Public module configuration (no secrets). Tracking 'direct' with every ID null: no external script loads.
   redirect null: the form shows its own success step (there is no thank-you page yet). */
window.CS_CONFIG = {
  siteId: 'workforce-pros',
  lead: {
    endpoint: '/api/lead.php',
    redirect: null,
    smsConsentVersion: 'sms-crew-en-v1-2026-10-25'
  },
  serviceArea: { zips: [], outOfArea: 'accept-with-message' },
  tracking: {
    mode: 'direct',
    ga4: null,
    metaPixel: null,
    googleAds: null,
    gtm: null,
    consentDefault: 'granted',
    leadValue: null,
    debugParam: 'cs_debug'
  }
};

// preview copy: the form is simulated and nothing is tracked
window.CS_CONFIG = Object.assign({}, window.CS_CONFIG, { preview: true });
window.CS_CONFIG.lead = Object.assign({}, window.CS_CONFIG.lead, { endpoint: '/workforce-pros-preview/api/lead.php', redirect: null });
window.CS_CONFIG.tracking = Object.assign({}, window.CS_CONFIG.tracking, { mode: 'off', ga4: null, metaPixel: null, googleAds: null, gtm: null });
