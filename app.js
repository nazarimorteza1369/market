(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const rawType = (params.get("type") || "human").toLowerCase();
  const decisionMaker = rawType === "agent" ? "agent" : "human";
  const isAgent = decisionMaker === "agent";
  const prolificPid = (params.get("PROLIFIC_PID") || "").trim();
  const studyIdParam = (params.get("STUDY_ID") || "").trim();
  const aiModel = (params.get("model") || (isAgent ? "unspecified-agent" : "")).trim();
  const runId = (params.get("run_id") || "").trim();
  const policyOverride = (params.get("policy") || "").trim().toLowerCase();
  const forceSurvey = params.get("survey") === "1";
  const rawLang = (params.get("lang") || "en").toLowerCase();
  let currentLang = rawLang === "fa" ? "fa" : "en";

  const state = {
    sessionId: null,
    participantCode: "",
    scenarios: [],
    currentIndex: 0,
    selectedOffer: null,
    scenarioStartMs: 0,
    activeModalOffer: null,
    activeModalType: null,
    modalOpenedMs: 0
  };

  const $ = (id) => document.getElementById(id);
  const appRoot = $("app-root");
  const views = {
    welcome: $("view-welcome"),
    consent: $("view-consent"),
    instructions: $("view-instructions"),
    marketplace: $("view-marketplace"),
    survey: $("view-survey"),
    complete: $("view-complete")
  };

  function dict() {
    return (window.GAZIN_I18N && window.GAZIN_I18N[currentLang]) || window.GAZIN_I18N.en;
  }

  function applyLanguage(lang) {
    currentLang = lang === "fa" ? "fa" : "en";
    const t = dict();
    document.documentElement.lang = currentLang;
    document.documentElement.dir = t.dir;
    document.title = t.pageTitle;
    appRoot.setAttribute("data-lang", currentLang);

    $("btn-lang-en").classList.toggle("active", currentLang === "en");
    $("btn-lang-fa").classList.toggle("active", currentLang === "fa");

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (typeof t[key] === "string") {
        el.textContent = t[key];
      }
    });

    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const key = el.getAttribute("data-i18n-html");
      if (typeof t[key] === "string") {
        el.innerHTML = t[key];
      }
    });

    $("participant-code-input").placeholder = t.pidPlaceholder;
    $("decision-rationale").placeholder = t.q4Placeholder;
  }

  function locScenario(sc) {
    const t = dict();
    if (t.scenarios && t.scenarios[sc.scenario_id]) {
      return Object.assign({}, sc, t.scenarios[sc.scenario_id]);
    }
    return sc;
  }

  function locSellerName(offer) {
    const t = dict();
    if (t.sellers && t.sellers[offer.seller_id]) {
      return t.sellers[offer.seller_id];
    }
    return offer.seller_name;
  }

  function locTenure(offer) {
    const t = dict();
    const raw = offer.tenure_label || `${offer.years_active} years`;
    if (t.tenureMap && t.tenureMap[raw]) {
      return t.tenureMap[raw];
    }
    return raw;
  }

  function showView(name) {
    Object.keys(views).forEach((k) => {
      views[k].classList.toggle("hidden", k !== name);
    });
    const showSticky = name === "marketplace";
    $("sticky-bar").classList.toggle("hidden", !showSticky);
    appRoot.setAttribute("data-study-status", name);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatUsd(val) {
    return "$" + Number(val).toFixed(2);
  }

  function formatInt(val) {
    return Number(val).toLocaleString("en-US");
  }

  function logEvent(eventType, offer, durationMs) {
    if (!state.sessionId) return;
    const sc = state.scenarios[state.currentIndex];
    if (!sc) return;
    window.GazinAPI.logEvent({
      session_id: state.sessionId,
      scenario_index: sc.scenario_index,
      scenario_id: sc.scenario_id,
      policy_condition: sc.policy_condition || "",
      is_diverse: sc.is_diverse != null ? sc.is_diverse : null,
      event_type: eventType,
      offer_id: offer ? offer.offer_id : "",
      seller_id: offer ? offer.seller_id : "",
      seller_size: offer ? offer.seller_size : "",
      display_rank: offer ? offer.display_rank : null,
      duration_ms: durationMs || 0
    });
  }

  // Keep UI 100% identical between human and agent views
  appRoot.setAttribute("data-decision-maker", decisionMaker);
  if (isAgent) {
    appRoot.setAttribute("data-ai-model", aiModel);
  }

  const pInput = $("participant-code-input");
  if (prolificPid) {
    pInput.value = prolificPid;
  } else if (isAgent) {
    pInput.value = runId ? `${aiModel}-run-${runId}` : `${aiModel}-run`;
  }

  // Language switcher listeners
  $("btn-lang-en").addEventListener("click", () => applyLanguage("en"));
  $("btn-lang-fa").addEventListener("click", () => applyLanguage("fa"));
  applyLanguage(currentLang);

  // Navigation handlers
  $("btn-to-consent").addEventListener("click", () => showView("consent"));
  $("btn-back-welcome").addEventListener("click", () => showView("welcome"));
  $("btn-back-consent").addEventListener("click", () => showView("consent"));

  $("consent-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!$("consent-checkbox").checked) return;
    state.participantCode = pInput.value.trim();
    showView("instructions");
  });

  $("btn-start-tasks").addEventListener("click", async () => {
    const t = dict();
    const btn = $("btn-start-tasks");
    const errBox = $("start-error");
    errBox.classList.add("hidden");
    btn.disabled = true;
    btn.textContent = t.btnLoadingStudy;

    const taggedStudyId = studyIdParam ? `${studyIdParam}|lang=${currentLang}` : `lang=${currentLang}`;

    try {
      const data = await window.GazinAPI.startSession({
        participant_code: state.participantCode,
        prolific_pid: prolificPid,
        study_id: taggedStudyId,
        decision_maker: decisionMaker,
        ai_model: aiModel,
        policy_override: policyOverride
      });
      state.sessionId = data.session_id;
      state.participantCode = data.participant_code;
      state.scenarios = data.scenarios;
      state.currentIndex = 0;
      renderScenario();
      showView("marketplace");
    } catch (err) {
      errBox.textContent = "Could not start session: " + err.message;
      errBox.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = t.btnBeginTasks;
    }
  });

  function renderScenario() {
    const t = dict();
    const rawSc = state.scenarios[state.currentIndex];
    const sc = locScenario(rawSc);
    const total = state.scenarios.length;
    const pct = Math.round(((state.currentIndex + 1) / total) * 100);

    state.selectedOffer = null;
    state.scenarioStartMs = Date.now();

    $("header-breadcrumb").textContent = `${t.breadcrumbPrefix} › ${sc.category} › ${sc.product_title}`;
    $("task-counter").textContent = t.taskOf(state.currentIndex + 1, total);
    $("task-title").textContent = sc.product_title;
    $("task-prompt").textContent = sc.prompt;
    $("progress-label-text").textContent = t.completePct(pct);
    $("progress-fill").style.width = `${pct}%`;

    updateSelectionUI();

    const listEl = $("offers-list");
    listEl.innerHTML = "";

    rawSc.offers.forEach((offer) => {
      const card = document.createElement("article");
      card.className = "offer-card";
      card.setAttribute("data-offer-id", offer.offer_id);
      card.setAttribute("data-seller-id", offer.seller_id);

      const sName = locSellerName(offer);
      const tenureStr = t.onPlatform(locTenure(offer));
      const catalogStr = t.storeCatalog(formatInt(offer.active_products));

      card.innerHTML = `
        <div class="offer-img-box">
          <img src="${escapeHtml(sc.image_url)}" alt="${escapeHtml(sc.product_title)}" />
        </div>
        <div class="offer-body">
          <h2 class="offer-title">${escapeHtml(sc.product_title)}</h2>
          <div class="offer-specs">${escapeHtml(sc.short_specs)}</div>
          <div class="offer-rating-line">
            <span class="stars"><bdi dir="ltr">&#9733; ${offer.seller_rating.toFixed(1)}</bdi></span>
            <span class="muted">(<bdi dir="ltr">${formatInt(offer.seller_review_count)}</bdi> ${escapeHtml(t.sellerRatingsWord)})</span>
            <span class="stock-pill">${escapeHtml(sc.availability)}</span>
          </div>
          <div class="seller-info-box">
            <div class="seller-link-row">
              <span class="muted">${escapeHtml(t.soldBy)}</span>
              <button type="button" class="seller-name-btn" data-action="open-seller">${escapeHtml(sName)}</button>
            </div>
            <div class="catalog-line"><strong>${escapeHtml(tenureStr)}</strong> &middot; ${escapeHtml(catalogStr)}</div>
          </div>
        </div>
        <div class="offer-action-col">
          <div class="price-tag"><bdi dir="ltr">${formatUsd(sc.price_usd)}</bdi></div>
          <div class="delivery-line">${escapeHtml(sc.delivery_text)}</div>
          <button type="button" class="btn btn-secondary btn-sm" data-action="open-offer">${escapeHtml(t.btnViewOffer)}</button>
          <button type="button" class="select-offer-btn" data-action="select-offer" role="radio" aria-checked="false">${escapeHtml(t.btnSelectOffer)}</button>
        </div>
      `;

      card.querySelector('[data-action="open-seller"]').addEventListener("click", () => openSellerModal(offer, sc));
      card.querySelector('[data-action="open-offer"]').addEventListener("click", () => openOfferModal(offer, sc));
      card.querySelector('[data-action="select-offer"]').addEventListener("click", () => selectOffer(offer));

      listEl.appendChild(card);
    });

    logEvent("scenario_viewed", null, 0);
  }

  function selectOffer(offer) {
    state.selectedOffer = offer;
    updateSelectionUI();
    logEvent("offer_selected_radio", offer, 0);
  }

  function updateSelectionUI() {
    const t = dict();
    const cards = document.querySelectorAll(".offer-card");
    cards.forEach((card) => {
      const oid = card.getAttribute("data-offer-id");
      const isSelected = state.selectedOffer && state.selectedOffer.offer_id === oid;
      card.classList.toggle("selected", Boolean(isSelected));
      const btn = card.querySelector('[data-action="select-offer"]');
      if (btn) {
        btn.setAttribute("aria-checked", isSelected ? "true" : "false");
        btn.textContent = isSelected ? t.btnSelectedOffer : t.btnSelectOffer;
      }
    });

    const rawSc = state.scenarios[state.currentIndex];
    const sc = rawSc ? locScenario(rawSc) : null;
    const sidebarBox = $("sidebar-selected-box");
    const stickyText = $("sticky-selection-text");
    const confirmBtn = $("btn-confirm-choice");

    if (state.selectedOffer && sc) {
      const sName = locSellerName(state.selectedOffer);
      const tLbl = locTenure(state.selectedOffer);
      sidebarBox.innerHTML = `
        <strong>${escapeHtml(sName)}</strong><br />
        <span class="muted"><bdi dir="ltr">${state.selectedOffer.seller_rating.toFixed(1)} &#9733;</bdi> (<bdi dir="ltr">${formatInt(state.selectedOffer.seller_review_count)}</bdi> ${escapeHtml(t.ratingsWord)}) &middot; ${escapeHtml(tLbl)}</span>
      `;
      stickyText.innerHTML = t.selectedSticky(escapeHtml(sName), formatUsd(sc.price_usd));
      confirmBtn.disabled = false;
    } else {
      sidebarBox.innerHTML = `<span class="muted">${escapeHtml(t.noOfferSelected)}</span>`;
      stickyText.textContent = t.stickyPrompt;
      confirmBtn.disabled = true;
    }
  }

  // Offer Detail Modal
  function openOfferModal(offer, sc) {
    const t = dict();
    state.activeModalOffer = offer;
    state.activeModalType = "offer";
    state.modalOpenedMs = Date.now();
    logEvent("offer_detail_opened", offer, 0);

    const sName = locSellerName(offer);
    const tenureStr = t.onPlatform(locTenure(offer));

    $("offer-modal-title").textContent = sc.product_title;
    $("offer-modal-content").innerHTML = `
      <div class="detail-grid">
        <div class="offer-img-box"><img src="${escapeHtml(sc.image_url)}" alt="${escapeHtml(sc.product_title)}" /></div>
        <div>
          <div class="price-tag"><bdi dir="ltr">${formatUsd(sc.price_usd)}</bdi></div>
          <p class="offer-rating-line">
            <span class="stars"><bdi dir="ltr">&#9733; ${offer.seller_rating.toFixed(1)}</bdi></span>
            <span class="muted">(<bdi dir="ltr">${formatInt(offer.seller_review_count)}</bdi> ${escapeHtml(t.sellerRatingsWord)})</span>
          </p>
          <p class="small-note">${escapeHtml(sc.full_description)}</p>
        </div>
      </div>
      <table class="spec-table">
        <tr><th>${escapeHtml(t.specSeller)}</th><td>${escapeHtml(sName)} (<bdi dir="ltr">${offer.seller_rating.toFixed(1)} &#9733;</bdi>, <bdi dir="ltr">${formatInt(offer.seller_review_count)}</bdi> ${escapeHtml(t.ratingsWord)})</td></tr>
        <tr><th>${escapeHtml(t.specTenure)}</th><td>${escapeHtml(tenureStr)}</td></tr>
        <tr><th>${escapeHtml(t.specCatalog)}</th><td>${escapeHtml(t.productsInStore(formatInt(offer.active_products)))}</td></tr>
        <tr><th>${escapeHtml(t.specKeySpecs)}</th><td>${escapeHtml(sc.short_specs)}</td></tr>
        <tr><th>${escapeHtml(t.specShipping)}</th><td>${escapeHtml(sc.delivery_text)}</td></tr>
        <tr><th>${escapeHtml(t.specWarranty)}</th><td>${escapeHtml(sc.warranty)}</td></tr>
        <tr><th>${escapeHtml(t.specReturns)}</th><td>${escapeHtml(sc.return_policy)}</td></tr>
        <tr><th>${escapeHtml(t.specAvailability)}</th><td>${escapeHtml(sc.availability)}</td></tr>
      </table>
    `;
    $("modal-offer").classList.remove("hidden");
  }

  function closeOfferModal() {
    if ($("modal-offer").classList.contains("hidden")) return;
    const dwell = Date.now() - state.modalOpenedMs;
    logEvent("offer_detail_closed", state.activeModalOffer, dwell);
    $("modal-offer").classList.add("hidden");
  }

  $("btn-close-offer").addEventListener("click", closeOfferModal);
  $("btn-offer-back").addEventListener("click", closeOfferModal);
  $("btn-offer-select").addEventListener("click", () => {
    if (state.activeModalOffer) selectOffer(state.activeModalOffer);
    closeOfferModal();
  });

  // Seller Profile Modal
  function openSellerModal(offer, sc) {
    const t = dict();
    state.activeModalOffer = offer;
    state.activeModalType = "seller";
    state.modalOpenedMs = Date.now();
    logEvent("seller_profile_opened", offer, 0);

    const sName = locSellerName(offer);
    const tLbl = locTenure(offer);

    $("seller-modal-title").textContent = sName;
    $("seller-modal-content").innerHTML = `
      <p class="muted">${escapeHtml(t.verifiedLine(tLbl, offer.on_time_rate))}</p>
      <div class="stat-cards-3">
        <div class="stat-tile">
          <div class="stat-val"><bdi dir="ltr">${offer.seller_rating.toFixed(1)} &#9733;</bdi></div>
          <div class="stat-lbl">${escapeHtml(t.statSellerRating)}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-val"><bdi dir="ltr">${formatInt(offer.seller_review_count)}</bdi></div>
          <div class="stat-lbl">${escapeHtml(t.statCustomerRatings)}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-val"><bdi dir="ltr">${formatInt(offer.active_products)}</bdi></div>
          <div class="stat-lbl">${escapeHtml(t.statProductsInStore)}</div>
        </div>
      </div>
      <table class="spec-table">
        <tr><th>${escapeHtml(t.specProductOffered)}</th><td>${escapeHtml(sc.product_title)}</td></tr>
        <tr><th>${escapeHtml(t.specOfferPrice)}</th><td><bdi dir="ltr">${formatUsd(sc.price_usd)}</bdi></td></tr>
        <tr><th>${escapeHtml(t.specShipping)}</th><td>${escapeHtml(sc.delivery_text)}</td></tr>
        <tr><th>${escapeHtml(t.specReturns)}</th><td>${escapeHtml(sc.return_policy)}</td></tr>
      </table>
    `;
    $("modal-seller").classList.remove("hidden");
  }

  function closeSellerModal() {
    if ($("modal-seller").classList.contains("hidden")) return;
    const dwell = Date.now() - state.modalOpenedMs;
    logEvent("seller_profile_closed", state.activeModalOffer, dwell);
    $("modal-seller").classList.add("hidden");
  }

  $("btn-close-seller").addEventListener("click", closeSellerModal);
  $("btn-seller-back").addEventListener("click", closeSellerModal);
  $("btn-seller-select").addEventListener("click", () => {
    if (state.activeModalOffer) selectOffer(state.activeModalOffer);
    closeSellerModal();
  });

  // Choice Confirmation Modal
  $("btn-confirm-choice").addEventListener("click", () => {
    if (!state.selectedOffer) return;
    const t = dict();
    const sc = locScenario(state.scenarios[state.currentIndex]);
    const sName = locSellerName(state.selectedOffer);
    $("confirm-modal-body").innerHTML = t.confirmModalBody(
      escapeHtml(sc.product_title),
      escapeHtml(sName),
      formatUsd(sc.price_usd)
    );
    $("modal-confirm").classList.remove("hidden");
  });

  $("btn-cancel-confirm").addEventListener("click", () => {
    $("modal-confirm").classList.add("hidden");
  });

  $("btn-submit-choice").addEventListener("click", async () => {
    if (!state.selectedOffer) return;
    const t = dict();
    const btn = $("btn-submit-choice");
    btn.disabled = true;
    btn.textContent = t.btnSaving;
    const sc = state.scenarios[state.currentIndex];
    const decisionTimeMs = Date.now() - state.scenarioStartMs;

    try {
      await window.GazinAPI.submitChoice({
        session_id: state.sessionId,
        scenario_index: sc.scenario_index,
        scenario_id: sc.scenario_id,
        offer_id: state.selectedOffer.offer_id,
        decision_time_ms: decisionTimeMs
      });
      $("modal-confirm").classList.add("hidden");

      if (state.currentIndex + 1 < state.scenarios.length) {
        state.currentIndex += 1;
        renderScenario();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (isAgent && !forceSurvey) {
        const res = await window.GazinAPI.completeAgentSession(state.sessionId);
        finishStudy(res.completion_code);
      } else {
        showView("survey");
      }
    } catch (err) {
      alert("Error saving selection: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = t.btnYesConfirm;
    }
  });

  // Survey Submission
  $("survey-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = dict();
    const errBox = $("survey-error");
    errBox.classList.add("hidden");
    const btn = $("btn-submit-survey");
    btn.disabled = true;
    btn.textContent = t.btnSubmitting;

    try {
      const res = await window.GazinAPI.submitSurvey({
        session_id: state.sessionId,
        attention_answer: $("attention-check").value,
        noticed_seller_size: $("noticed-size").value,
        size_influence_rating: $("size-influence").value,
        decision_rationale: $("decision-rationale").value,
        age_group: $("age-group").value,
        shopping_frequency: $("shopping-freq").value
      });
      finishStudy(res.completion_code);
    } catch (err) {
      errBox.textContent = "Submission error: " + err.message;
      errBox.classList.remove("hidden");
      btn.disabled = false;
      btn.textContent = t.btnSubmitStudy;
    }
  });

  function finishStudy(code) {
    $("completion-code-text").textContent = code || "GAZIN-2026-COMPLETE";
    showView("complete");
    appRoot.setAttribute("data-study-status", "complete");
  }

  $("btn-copy-code").addEventListener("click", () => {
    const t = dict();
    const txt = $("completion-code-text").textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(txt).then(() => {
        $("btn-copy-code").textContent = t.btnCopied;
        setTimeout(() => { $("btn-copy-code").textContent = t.btnCopyCode; }, 1800);
      });
    }
  });
})();
