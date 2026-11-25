(function () {
  "use strict";

  const cfg = window.GAZIN_CONFIG || {};
  const SUPABASE_URL = (cfg.supabaseUrl || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
  const SUPABASE_ANON_KEY = (cfg.supabaseAnonKey || "").trim();
  const IS_CLOUD = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

  const cloudInspected = {};
  const cloudShownOffers = {};

  function uuidHex() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID().replace(/-/g, "");
    }
    return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function select4StratifiedScenarios(allScenarios, policyOverride) {
    const byKey = {};
    const cats = [];
    allScenarios.forEach((sc) => {
      if (!cats.includes(sc.category_key)) cats.push(sc.category_key);
      byKey[`${sc.category_key}|${sc.involvement}`] = sc;
    });
    const shuffledCats = shuffle(cats);
    const chosenScenarios = shuffle([
      byKey[`${shuffledCats[0]}|low`],
      byKey[`${shuffledCats[1]}|low`],
      byKey[`${shuffledCats[2]}|high`],
      byKey[`${shuffledCats[3]}|high`]
    ]);

    // Alternating task policies: Popular -> Diverse -> Popular -> Diverse (unless overridden)
    const policies =
      policyOverride === "popularity" || policyOverride === "diversity"
        ? [policyOverride, policyOverride, policyOverride, policyOverride]
        : ["popularity", "diversity", "popularity", "diversity"];

    // Cross discount (0 vs 1) evenly across the two popularity slots (0,2) and two diversity slots (1,3)
    const popDisc = shuffle([0, 1]);
    const divDisc = shuffle([0, 1]);
    const discounts = [popDisc[0], divDisc[0], popDisc[1], divDisc[1]];

    return chosenScenarios.map((sc, idx) => ({
      sc,
      policyCondition: policies[idx],
      isDiverse: policies[idx] === "diversity" ? 1 : 0,
      hasDiscount: discounts[idx]
    }));
  }

  function assignDynamicRatings(estList, lowList) {
    // Established (>1000 ratings): 1 random gets 4.7; remaining 4 get [4.8, 4.6, 4.5, 4.4]
    // in ascending order of review count (higher review count => lower rating).
    const estClones = estList.map((s) => Object.assign({}, s));
    const pickIdx = Math.floor(Math.random() * estClones.length);
    estClones[pickIdx].seller_rating = 4.7;
    const restEst = estClones
      .filter((_, idx) => idx !== pickIdx)
      .sort((a, b) => Number(a.seller_review_count) - Number(b.seller_review_count));
    const restScores = [4.8, 4.6, 4.5, 4.4];
    restEst.forEach((s, i) => {
      s.seller_rating = restScores[i];
    });

    // Low-history: exact same 5 ratings [4.8, 4.7, 4.6, 4.5, 4.4] shuffled randomly (mean = 4.60).
    const lowClones = lowList.map((s) => Object.assign({}, s));
    const lowScores = shuffle([4.8, 4.7, 4.6, 4.5, 4.4]);
    lowClones.forEach((s, i) => {
      s.seller_rating = lowScores[i];
    });

    // Sort both groups strictly descending by seller_review_count (popularity) without shuffling names
    const estSorted = estClones.sort((a, b) => Number(b.seller_review_count) - Number(a.seller_review_count));
    const lowSorted = lowClones.sort((a, b) => Number(b.seller_review_count) - Number(a.seller_review_count));
    return { estRated: estSorted, lowRated: lowSorted };
  }

  function buildScenarioOffers(scenario, policyCondition) {
    const rawEst = scenario.sellers.filter((s) => s.is_low_history === 0);
    const rawLow = scenario.sellers.filter((s) => s.is_low_history === 1);
    const { estRated, lowRated } = assignDynamicRatings(rawEst, rawLow);

    if (policyCondition === "popularity") {
      return {
        ordered: estRated.concat(lowRated),
        lowTop2Pos: null
      };
    }
    // Top-2 Diversity Guarantee: promote a random qualified low-history seller (rating >= 4.7) to Rank 1 or 2
    const qualifiedPool = lowRated.filter((s) => Number(s.seller_rating) >= 4.7);
    const promoted = qualifiedPool.length > 0
      ? qualifiedPool[Math.floor(Math.random() * qualifiedPool.length)]
      : lowRated[0];
    const remainingLow = lowRated.filter((s) => s.offer_id !== promoted.offer_id);
    const pos = Math.random() < 0.5 ? 1 : 2;
    const topPart = estRated.slice(0, pos - 1).concat([promoted], estRated.slice(pos - 1));
    return {
      ordered: topPart.concat(remainingLow),
      lowTop2Pos: pos
    };
  }

  async function postLocalJson(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function supaReq(path, method, key, body, extraHeaders) {
    const baseHeaders = {
      apikey: key,
      "Content-Type": "application/json"
    };
    if (key && key.startsWith("eyJ")) {
      baseHeaders.Authorization = "Bearer " + key;
    }
    const headers = Object.assign(baseHeaders, extraHeaders || {});
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const txt = await res.text();
    if (!res.ok) {
      let msg = txt || `HTTP ${res.status}`;
      try {
        const j = JSON.parse(txt);
        msg = j.message || j.error || msg;
      } catch {}
      throw new Error(msg);
    }
    return txt ? JSON.parse(txt) : null;
  }

  function escapeCsv(val) {
    if (val === null || val === undefined) return "";
    const s = String(val);
    if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function triggerCsvDownload(filename, headers, rows) {
    const lines = [headers.map(escapeCsv).join(",")];
    rows.forEach((r) => lines.push(r.map(escapeCsv).join(",")));
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function computeMeanWithinProductHHI(choiceRows) {
    if (!choiceRows || choiceRows.length === 0) return { hhi01: null, hhi10k: null };
    const byProd = {};
    choiceRows.forEach((r) => {
      if (!byProd[r.scenario_id]) byProd[r.scenario_id] = [];
      byProd[r.scenario_id].push(r.chosen_seller_id);
    });
    const prodHhis = Object.values(byProd).map((sids) => {
      const n = sids.length;
      const counts = {};
      sids.forEach((id) => (counts[id] = (counts[id] || 0) + 1));
      let sq = 0;
      Object.values(counts).forEach((c) => {
        const sh = c / n;
        sq += sh * sh;
      });
      return sq;
    });
    if (prodHhis.length === 0) return { hhi01: null, hhi10k: null };
    const meanVal = prodHhis.reduce((a, b) => a + b, 0) / prodHhis.length;
    return {
      hhi01: Number(meanVal.toFixed(4)),
      hhi10k: Math.round(meanVal * 10000)
    };
  }

  const GazinAPI = {
    isCloudMode: IS_CLOUD,

    async startSession(payload) {
      if (!IS_CLOUD) {
        return postLocalJson("/api/session/start", payload);
      }

      const studyRes = await fetch("./scenarios_data.json");
      if (!studyRes.ok) throw new Error("Failed to load scenarios_data.json");
      const studyData = await studyRes.json();

      const dm = payload.decision_maker === "agent" ? "agent" : "human";
      const isAgent = dm === "agent" ? 1 : 0;
      const aiModel = isAgent ? (payload.ai_model || "").trim() : "";
      const prolificPid = (payload.prolific_pid || "").trim();
      const studyId = (payload.study_id || "").trim();
      const sessionId = uuidHex();
      const pCode =
        (payload.participant_code || "").trim() ||
        prolificPid ||
        (isAgent ? `AGENT-${sessionId.slice(0, 6).toUpperCase()}` : `H-${sessionId.slice(0, 6).toUpperCase()}`);

      const polOverride = (payload.policy_override || "").trim().toLowerCase();
      const sessionPolicy =
        polOverride === "popularity" || polOverride === "diversity"
          ? polOverride
          : "within_alternating";
      const sessionIsDiverse = sessionPolicy === "diversity" ? 1 : 0;

      const selectedPairs = select4StratifiedScenarios(studyData.scenarios, polOverride);
      const scenarioOrder = selectedPairs.map((p) => ({
        scenario_id: p.sc.scenario_id,
        policy_condition: p.policyCondition,
        has_discount: p.hasDiscount
      }));

      await supaReq("sessions", "POST", SUPABASE_ANON_KEY, {
        session_id: sessionId,
        participant_code: pCode,
        prolific_pid: prolificPid,
        study_id: studyId,
        decision_maker: dm,
        is_agent: isAgent,
        ai_model: aiModel,
        policy_condition: sessionPolicy,
        is_diverse: sessionIsDiverse,
        scenario_order_json: JSON.stringify(scenarioOrder),
        completed: 0
      });

      const shownRows = [];
      const clientScenarios = [];

      selectedPairs.forEach((pair, i) => {
        const sc = pair.sc;
        const taskPolicy = pair.policyCondition;
        const taskIsDiverse = pair.isDiverse;
        const hasDisc = pair.hasDiscount;
        const baseP = Number(sc.base_price_usd);
        const scIndex = i + 1;

        const { ordered, lowTop2Pos } = buildScenarioOffers(sc, taskPolicy);
        const clientOffers = ordered.map((sel, rIdx) => {
          const rank = rIdx + 1;
          const isLow = Number(sel.is_low_history);
          let offerDiscPct = 0;
          if (hasDisc === 1 && isLow === 1) {
            offerDiscPct = Number(sel.seller_rating) <= 4.65 ? 8.0 : 6.0;
          }
          const offerP = offerDiscPct > 0
            ? Number((baseP * (1 - offerDiscPct / 100)).toFixed(2))
            : baseP;

          const row = {
            session_id: sessionId,
            scenario_index: scIndex,
            scenario_id: sc.scenario_id,
            category_key: sc.category_key,
            product_involvement: sc.involvement,
            policy_condition: taskPolicy,
            is_diverse: taskIsDiverse,
            has_discount: hasDisc,
            discount_pct: offerDiscPct,
            base_price_usd: baseP,
            offer_price_usd: offerP,
            offer_id: sel.offer_id,
            seller_id: sel.seller_id,
            seller_name: sel.seller_name,
            seller_group: sel.seller_group,
            is_low_history: isLow,
            seller_rating: sel.seller_rating,
            seller_review_count: sel.seller_review_count,
            tenure_short: sel.tenure_short,
            display_rank: rank,
            low_history_top2_pos: lowTop2Pos
          };
          shownRows.push(row);
          cloudShownOffers[`${sessionId}|${scIndex}|${sel.offer_id}`] = row;
          return Object.assign({}, sel, { display_rank: rank, offer_price_usd: offerP, discount_pct: offerDiscPct });
        });

        clientScenarios.push({
          scenario_index: scIndex,
          scenario_id: sc.scenario_id,
          category_key: sc.category_key,
          category: sc.category,
          involvement: sc.involvement,
          policy_condition: taskPolicy,
          is_diverse: taskIsDiverse,
          has_discount: hasDisc,
          base_price_usd: baseP,
          product_title: sc.product_title,
          image_url: sc.image_url,
          product_rating: sc.product_rating,
          product_review_count: sc.product_review_count,
          short_specs: sc.short_specs,
          full_description: sc.full_description,
          warranty: sc.warranty,
          delivery_text: sc.delivery_text,
          return_policy: sc.return_policy,
          availability: sc.availability,
          prompt: sc.prompt,
          offers: clientOffers
        });
      });

      await supaReq("shown_offers", "POST", SUPABASE_ANON_KEY, shownRows);

      return {
        session_id: sessionId,
        participant_code: pCode,
        decision_maker: dm,
        is_agent: isAgent,
        policy_condition: sessionPolicy,
        is_diverse: sessionIsDiverse,
        scenarios: clientScenarios
      };
    },

    logEvent(payload) {
      if (!IS_CLOUD) {
        fetch("/api/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(() => {});
        return;
      }

      if (
        (payload.event_type === "offer_detail_opened" || payload.event_type === "seller_profile_opened") &&
        payload.offer_id
      ) {
        const key = `${payload.session_id}|${payload.scenario_index}`;
        if (!cloudInspected[key]) cloudInspected[key] = {};
        cloudInspected[key][payload.offer_id] = payload.seller_group || "";
      }

      supaReq("events", "POST", SUPABASE_ANON_KEY, {
        session_id: payload.session_id,
        scenario_index: payload.scenario_index,
        scenario_id: payload.scenario_id,
        event_type: payload.event_type,
        offer_id: payload.offer_id || "",
        seller_id: payload.seller_id || "",
        seller_group: payload.seller_group || "",
        display_rank: payload.display_rank != null ? payload.display_rank : null,
        duration_ms: payload.duration_ms || 0
      }).catch(() => {});
    },

    async submitChoice(payload) {
      if (!IS_CLOUD) {
        return postLocalJson("/api/choice", payload);
      }

      const offerRow = cloudShownOffers[`${payload.session_id}|${payload.scenario_index}|${payload.offer_id}`];
      if (!offerRow) throw new Error("Offer metadata not found");

      const inspMap = cloudInspected[`${payload.session_id}|${payload.scenario_index}`] || {};
      const inspVals = Object.values(inspMap);
      const inspCount = inspVals.length;
      const inspLow = inspVals.filter((v) => v === "low_history").length;
      const inspEst = inspVals.filter((v) => v === "established").length;

      await supaReq("choices", "POST", SUPABASE_ANON_KEY, {
        session_id: payload.session_id,
        scenario_index: payload.scenario_index,
        scenario_id: offerRow.scenario_id,
        category_key: offerRow.category_key,
        product_involvement: offerRow.product_involvement,
        policy_condition: offerRow.policy_condition,
        is_diverse: offerRow.is_diverse,
        has_discount: offerRow.has_discount,
        discount_pct: offerRow.discount_pct,
        base_price_usd: offerRow.base_price_usd,
        chosen_price_usd: offerRow.offer_price_usd,
        offer_id: offerRow.offer_id,
        chosen_seller_id: offerRow.seller_id,
        chosen_seller_name: offerRow.seller_name,
        chose_low_history: offerRow.is_low_history,
        chosen_seller_group: offerRow.seller_group,
        chosen_seller_rating: offerRow.seller_rating,
        chosen_seller_reviews: offerRow.seller_review_count,
        chosen_rank: offerRow.display_rank,
        low_history_top2_pos: offerRow.low_history_top2_pos,
        inspected_count: inspCount,
        inspected_low_history: inspLow,
        inspected_established: inspEst,
        decision_time_ms: payload.decision_time_ms || 0
      });

      return { ok: true };
    },

    async submitSurvey(payload) {
      if (!IS_CLOUD) {
        return postLocalJson("/api/survey", payload);
      }
      const passedAtt = (payload.attention_answer || "").toLowerCase() === "strongly_disagree" ? 1 : 0;
      const code = "GAZIN-2026-COMPLETE";
      await supaReq(`sessions?session_id=eq.${encodeURIComponent(payload.session_id)}`, "PATCH", SUPABASE_ANON_KEY, {
        completed: 1,
        passed_attention_check: passedAtt,
        attention_answer: payload.attention_answer || "",
        noticed_seller_history: payload.noticed_seller_history || "",
        history_influence_rating: payload.history_influence_rating ? Number(payload.history_influence_rating) : null,
        noticed_price_diff: payload.noticed_price_diff || "",
        decision_rationale: payload.decision_rationale || "",
        age_group: payload.age_group || "",
        shopping_frequency: payload.shopping_frequency || "",
        completion_code: code,
        completed_at: new Date().toISOString()
      });
      return { ok: true, passed_attention_check: passedAtt, completion_code: code };
    },

    async completeAgentSession(sessionId) {
      if (!IS_CLOUD) {
        return postLocalJson("/api/session/complete", { session_id: sessionId });
      }
      const code = "AGENT-RUN-COMPLETE";
      await supaReq(`sessions?session_id=eq.${encodeURIComponent(sessionId)}`, "PATCH", SUPABASE_ANON_KEY, {
        completed: 1,
        completion_code: code,
        completed_at: new Date().toISOString()
      });
      return { ok: true, completion_code: code };
    },

    async adminFetchAllCloud(serviceKey) {
      const [sessions, choices, shownOffers, events] = await Promise.all([
        supaReq("sessions?select=*&order=created_at.desc&limit=5000", "GET", serviceKey),
        supaReq("choices?select=*&order=created_at.asc&limit=20000", "GET", serviceKey),
        supaReq("shown_offers?select=*&order=id.asc&limit=80000", "GET", serviceKey),
        supaReq("events?select=*&order=event_id.asc&limit=80000", "GET", serviceKey)
      ]);
      return { sessions: sessions || [], choices: choices || [], shownOffers: shownOffers || [], events: events || [] };
    },

    async adminGetSummary(adminKey) {
      if (!IS_CLOUD) {
        const res = await fetch(`/api/admin/summary?key=${encodeURIComponent(adminKey)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Unauthorized");
        return data;
      }

      const { sessions, choices } = await this.adminFetchAllCloud(adminKey);
      const sessMap = {};
      sessions.forEach((s) => (sessMap[s.session_id] = s));

      const completed = sessions.filter((s) => s.completed === 1);
      const humanComp = completed.filter((s) => s.is_agent === 0).length;
      const agentComp = completed.filter((s) => s.is_agent === 1).length;
      const attRows = completed.filter((s) => s.is_agent === 0 && s.passed_attention_check !== null);
      const attRate =
        attRows.length > 0
          ? Number((attRows.reduce((acc, r) => acc + r.passed_attention_check, 0) / attRows.length).toFixed(4))
          : null;

      const cells = [];
      [
        ["human", 0],
        ["agent", 1]
      ].forEach(([dm, isA]) => {
        [
          ["popularity", 0],
          ["diversity", 1]
        ].forEach(([pol, isD]) => {
          [0, 1].forEach((hasDisc) => {
            const cRows = choices.filter((c) => {
              const s = sessMap[c.session_id];
              const cDiv = c.is_diverse !== undefined && c.is_diverse !== null ? c.is_diverse : (s ? s.is_diverse : null);
              return s && s.is_agent === isA && cDiv === isD && c.has_discount === hasDisc;
            });
            const n = cRows.length;
            const lowRate = n > 0 ? Number((cRows.reduce((a, r) => a + r.chose_low_history, 0) / n).toFixed(4)) : null;
            const avgInsp = n > 0 ? Number((cRows.reduce((a, r) => a + r.inspected_count, 0) / n).toFixed(2)) : null;
            const hhi = computeMeanWithinProductHHI(cRows);
            cells.push({
              decision_maker: dm,
              is_agent: isA,
              policy_condition: pol,
              is_diverse: isD,
              has_discount: hasDisc,
              n_choices: n,
              low_history_choice_rate: lowRate,
              hhi_0_1: hhi.hhi01,
              hhi_10000: hhi.hhi10k,
              avg_inspected_offers: avgInsp
            });
          });
        });
      });

      const choiceCounts = {};
      choices.forEach((c) => (choiceCounts[c.session_id] = (choiceCounts[c.session_id] || 0) + 1));

      return {
        counts: {
          total_sessions: sessions.length,
          completed_sessions: completed.length,
          human_completed: humanComp,
          agent_completed: agentComp,
          total_choices: choices.length,
          attention_pass_rate: attRate
        },
        cells,
        recent_sessions: sessions.slice(0, 30).map((s) => Object.assign({}, s, { choices_count: choiceCounts[s.session_id] || 0 }))
      };
    },

    async adminDownloadCsv(adminKey, fileType) {
      if (!IS_CLOUD) {
        window.location.href = `/api/admin/export/${fileType}?key=${encodeURIComponent(adminKey)}`;
        return;
      }

      const { sessions, choices, shownOffers, events } = await this.adminFetchAllCloud(adminKey);
      const sessMap = {};
      sessions.forEach((s) => (sessMap[s.session_id] = s));

      if (fileType === "choices.csv") {
        const headers = [
          "session_id","participant_code","prolific_pid","is_agent","decision_maker","ai_model",
          "is_diverse","policy_condition","scenario_index","scenario_id","category_key","product_involvement",
          "has_discount","discount_pct","base_price_usd","chosen_price_usd",
          "chosen_seller_id","chosen_seller_name","chose_low_history","chosen_seller_group",
          "chosen_seller_rating","chosen_seller_reviews","chosen_rank","low_history_top2_pos",
          "inspected_count","inspected_low_history","inspected_established",
          "decision_time_ms","passed_attention_check","noticed_seller_history",
          "history_influence_rating","noticed_price_diff","created_at"
        ];
        const rows = choices
          .filter((c) => sessMap[c.session_id])
          .map((c) => {
            const s = sessMap[c.session_id];
            return [
              c.session_id, s.participant_code, s.prolific_pid, s.is_agent, s.decision_maker, s.ai_model,
              c.is_diverse ?? s.is_diverse, c.policy_condition || s.policy_condition, c.scenario_index, c.scenario_id, c.category_key, c.product_involvement,
              c.has_discount, c.discount_pct, c.base_price_usd, c.chosen_price_usd,
              c.chosen_seller_id, c.chosen_seller_name, c.chose_low_history, c.chosen_seller_group,
              c.chosen_seller_rating, c.chosen_seller_reviews, c.chosen_rank, c.low_history_top2_pos ?? "",
              c.inspected_count, c.inspected_low_history, c.inspected_established,
              c.decision_time_ms, s.passed_attention_check ?? "", s.noticed_seller_history,
              s.history_influence_rating ?? "", s.noticed_price_diff, c.created_at
            ];
          });
        triggerCsvDownload("choices_regression.csv", headers, rows);
      } else if (fileType === "offers_long.csv") {
        const headers = [
          "session_id","participant_code","is_agent","decision_maker","ai_model","is_diverse","policy_condition",
          "scenario_index","scenario_id","category_key","product_involvement","has_discount","discount_pct",
          "base_price_usd","offer_price_usd","offer_id","seller_id","seller_name","is_low_history",
          "seller_group","seller_rating","seller_review_count","tenure_short",
          "display_rank","low_history_top2_pos","was_inspected","chosen"
        ];
        const choiceLookup = {};
        choices.forEach((c) => (choiceLookup[`${c.session_id}|${c.scenario_index}`] = c.offer_id));
        const inspLookup = {};
        events.forEach((e) => {
          if (e.event_type === "offer_detail_opened" || e.event_type === "seller_profile_opened") {
            inspLookup[`${e.session_id}|${e.scenario_index}|${e.offer_id}`] = true;
          }
        });
        const rows = shownOffers
          .filter((o) => sessMap[o.session_id] && choiceLookup[`${o.session_id}|${o.scenario_index}`])
          .map((o) => {
            const s = sessMap[o.session_id];
            const k = `${o.session_id}|${o.scenario_index}`;
            return [
              o.session_id, s.participant_code, s.is_agent, s.decision_maker, s.ai_model,
              o.is_diverse ?? s.is_diverse, o.policy_condition || s.policy_condition, o.scenario_index, o.scenario_id, o.category_key,
              o.product_involvement, o.has_discount, o.discount_pct, o.base_price_usd, o.offer_price_usd,
              o.offer_id, o.seller_id, o.seller_name, o.is_low_history, o.seller_group,
              o.seller_rating, o.seller_review_count, o.tenure_short,
              o.display_rank, o.low_history_top2_pos ?? "",
              inspLookup[`${k}|${o.offer_id}`] ? 1 : 0,
              choiceLookup[k] === o.offer_id ? 1 : 0
            ];
          });
        triggerCsvDownload("offers_long_logit.csv", headers, rows);
      } else if (fileType === "events.csv") {
        const headers = [
          "event_id","session_id","participant_code","is_agent","is_diverse","scenario_index","scenario_id",
          "event_type","offer_id","seller_id","seller_group","display_rank","duration_ms","created_at"
        ];
        const rows = events
          .filter((e) => sessMap[e.session_id])
          .map((e) => {
            const s = sessMap[e.session_id];
            return [
              e.event_id, e.session_id, s.participant_code, s.is_agent, s.is_diverse,
              e.scenario_index, e.scenario_id, e.event_type, e.offer_id, e.seller_id, e.seller_group,
              e.display_rank ?? "", e.duration_ms, e.created_at
            ];
          });
        triggerCsvDownload("events.csv", headers, rows);
      } else if (fileType === "sessions.csv") {
        const headers = [
          "session_id","participant_code","prolific_pid","decision_maker","is_agent","ai_model",
          "policy_condition","is_diverse","completed","passed_attention_check","noticed_seller_history",
          "history_influence_rating","noticed_price_diff","decision_rationale","age_group","shopping_frequency",
          "created_at","completed_at"
        ];
        const rows = sessions.map((s) => [
          s.session_id, s.participant_code, s.prolific_pid, s.decision_maker, s.is_agent, s.ai_model,
          s.policy_condition, s.is_diverse, s.completed, s.passed_attention_check ?? "", s.noticed_seller_history,
          s.history_influence_rating ?? "", s.noticed_price_diff, s.decision_rationale, s.age_group, s.shopping_frequency,
          s.created_at, s.completed_at || ""
        ]);
        triggerCsvDownload("sessions.csv", headers, rows);
      }
    },

    async adminDeleteTest(adminKey) {
      if (!IS_CLOUD) {
        const res = await fetch(`/api/admin/delete-test?key=${encodeURIComponent(adminKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Delete failed");
        return data;
      }

      const deleted = await supaReq(
        "sessions?participant_code=ilike.TEST*",
        "DELETE",
        adminKey,
        undefined,
        { Prefer: "return=representation" }
      );
      return { ok: true, deleted_sessions: Array.isArray(deleted) ? deleted.length : 0 };
    }
  };

  window.GazinAPI = GazinAPI;
})();
