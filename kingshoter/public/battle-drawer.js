(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BattleDrawer = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var STATES = ["manage", "command", "closed"];
  var INTERACTIVE_SELECTOR = "button,a,input,select,textarea,[contenteditable=true],[data-drawer-no-drag]";
  var FOCUSABLE_SELECTOR = "button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[contenteditable]:not([contenteditable='false']),[tabindex]:not([tabindex='-1'])";

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function finite(value, fallback) {
    value = Number(value);
    return Number.isFinite(value) ? value : fallback;
  }

  function isElement(value) {
    return !!value && typeof value.addEventListener === "function" && value.style;
  }

  function mediaMatches(media) {
    return media === true || !!(media && media.matches);
  }

  function captureAttribute(element, name) {
    return {
      present: !!(element && element.hasAttribute && element.hasAttribute(name)),
      value: element && element.getAttribute ? element.getAttribute(name) : null
    };
  }

  function restoreAttribute(element, name, snapshot) {
    if (!element || !snapshot) return;
    if (snapshot.present) element.setAttribute(name, snapshot.value === null ? "" : snapshot.value);
    else element.removeAttribute(name);
  }

  function captureDataset(element, name) {
    return {
      present: !!(element && element.dataset && Object.prototype.hasOwnProperty.call(element.dataset, name)),
      value: element && element.dataset ? element.dataset[name] : undefined
    };
  }

  function restoreDataset(element, name, snapshot) {
    if (!element || !element.dataset || !snapshot) return;
    if (snapshot.present) element.dataset[name] = snapshot.value;
    else delete element.dataset[name];
  }

  function captureStyle(element, name) {
    return element && element.style ? element.style.getPropertyValue(name) : "";
  }

  function restoreStyle(element, name, value) {
    if (!element || !element.style) return;
    if (value) element.style.setProperty(name, value);
    else element.style.removeProperty(name);
  }

  function create(options) {
    options = options || {};
    var drawerRoot = options.root;
    var handle = options.handle;
    var background = options.background || null;
    if (!isElement(drawerRoot)) throw new TypeError("BattleDrawer requires a root element");
    if (!isElement(handle)) throw new TypeError("BattleDrawer requires a handle element");

    var doc = drawerRoot.ownerDocument || (typeof document !== "undefined" ? document : null);
    var view = doc && doc.defaultView ? doc.defaultView : (typeof window !== "undefined" ? window : null);
    var reducedMotion = options.reducedMotion || false;
    var returnFocus = isElement(options.returnFocus) ? options.returnFocus : null;
    var onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : function () {};
    var destroyed = false;
    var stateName = "closed";
    var currentY = 0;
    var drag = null;
    var modalSnapshot = null;
    var focusReturn = null;
    var closedFocusReturn = null;
    var pointerTracking = false;
    var initialDom = {
      rootInert: !!drawerRoot.inert,
      rootAttributes: {
        inert: captureAttribute(drawerRoot, "inert"),
        role: captureAttribute(drawerRoot, "role"),
        ariaHidden: captureAttribute(drawerRoot, "aria-hidden"),
        ariaModal: captureAttribute(drawerRoot, "aria-modal")
      },
      rootDataset: {
        state: captureDataset(drawerRoot, "drawerState"),
        motion: captureDataset(drawerRoot, "drawerMotion")
      },
      rootStyle: {
        y: captureStyle(drawerRoot, "--battle-drawer-y"),
        duration: captureStyle(drawerRoot, "--battle-drawer-duration")
      },
      rootClasses: {
        dragging: drawerRoot.classList.contains("is-dragging"),
        settling: drawerRoot.classList.contains("is-settling")
      },
      handleAttributes: {
        role: captureAttribute(handle, "role"),
        controls: captureAttribute(handle, "aria-controls"),
        tabindex: captureAttribute(handle, "tabindex"),
        expanded: captureAttribute(handle, "aria-expanded"),
        valueText: captureAttribute(handle, "aria-valuetext")
      },
      backgroundInert: background ? !!background.inert : false,
      backgroundInertAttribute: captureAttribute(background, "inert"),
      backgroundState: captureDataset(background, "drawerBackgroundState")
    };

    function measure() {
      var rect = drawerRoot.getBoundingClientRect ? drawerRoot.getBoundingClientRect() : null;
      var viewportHeight = finite(view && view.innerHeight, 0);
      var height = viewportHeight > 0 ? viewportHeight : finite(rect && rect.height, 0);
      if (height <= 0) height = finite(view && view.innerHeight, 800);
      var commandHeight = clamp(height * 0.43, 300, 390);
      commandHeight = Math.min(commandHeight, Math.max(0, height - 160));
      return Object.freeze({ manage: 0, command: height - commandHeight, closed: height });
    }

    var detents = measure();

    function setY(value) {
      currentY = finite(value, currentY);
      drawerRoot.style.setProperty("--battle-drawer-y", currentY + "px");
    }

    function setDataset(name, value) {
      if (drawerRoot.dataset) drawerRoot.dataset[name] = String(value);
    }

    function parseTransformY(transform) {
      if (!transform || transform === "none") return null;
      var match3d = /^matrix3d\((.+)\)$/.exec(transform);
      if (match3d) {
        var values3d = match3d[1].split(",").map(Number);
        return Number.isFinite(values3d[13]) ? values3d[13] : null;
      }
      var match2d = /^matrix\((.+)\)$/.exec(transform);
      if (match2d) {
        var values2d = match2d[1].split(",").map(Number);
        return Number.isFinite(values2d[5]) ? values2d[5] : null;
      }
      return null;
    }

    function presentationY() {
      if (!view || typeof view.getComputedStyle !== "function") return currentY;
      var style = view.getComputedStyle(drawerRoot);
      var parsed = parseTransformY(style && style.transform);
      return parsed === null ? currentY : parsed;
    }

    function interruptSettle() {
      if (!drawerRoot.classList.contains("is-settling")) return;
      var visibleY = presentationY();
      drawerRoot.classList.remove("is-settling");
      drawerRoot.style.setProperty("--battle-drawer-duration", "0ms");
      setY(visibleY);
    }

    function isActuallyFocusable(element) {
      if (!element || element.disabled || element.hidden || element.inert || typeof element.focus !== "function") return false;
      if (element.getAttribute && element.getAttribute("aria-hidden") === "true") return false;
      if (element.closest && element.closest("[hidden],[inert],[aria-hidden='true']")) return false;
      if (view && typeof view.getComputedStyle === "function") {
        var style = view.getComputedStyle(element);
        if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")) return false;
      }
      if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
      return true;
    }

    function queryFocusable(selector) {
      if (!drawerRoot.querySelectorAll) return [];
      return Array.prototype.slice.call(drawerRoot.querySelectorAll(selector)).filter(isActuallyFocusable);
    }

    function focusables() {
      return queryFocusable(FOCUSABLE_SELECTOR);
    }

    function enterManage() {
      if (modalSnapshot) return;
      var active = doc && doc.activeElement;
      focusReturn = active && active !== doc.body && active !== drawerRoot && typeof active.focus === "function"
        ? active : null;
      if (background) {
        modalSnapshot = {
          inert: !!background.inert,
          inertAttribute: !!(background.hasAttribute && background.hasAttribute("inert"))
        };
        background.inert = true;
        if (background.setAttribute) background.setAttribute("inert", "");
      } else {
        modalSnapshot = { inert: false, inertAttribute: false };
      }
    }

    function focusManage() {
      var items = focusables();
      var preferred = queryFocusable("[data-drawer-focus]")[0] || null;
      if (preferred) preferred.focus();
      else if (items[0]) items[0].focus();
    }

    function leaveManage(restoreFocus) {
      if (!modalSnapshot) return null;
      var target = focusReturn;
      if (background) {
        background.inert = modalSnapshot.inert;
        if (modalSnapshot.inertAttribute) background.setAttribute("inert", "");
        else if (background.removeAttribute) background.removeAttribute("inert");
      }
      modalSnapshot = null;
      focusReturn = null;
      if (restoreFocus && target && typeof target.focus === "function") target.focus();
      return target;
    }

    function paintState(nextState) {
      setDataset("drawerState", nextState);
      if (background && background.dataset) background.dataset.drawerBackgroundState = nextState;
      handle.setAttribute("aria-expanded", nextState === "closed" ? "false" : "true");
      drawerRoot.setAttribute("aria-hidden", nextState === "closed" ? "true" : "false");
      drawerRoot.inert = nextState === "closed";
      if (nextState === "closed") drawerRoot.setAttribute("inert", "");
      else drawerRoot.removeAttribute("inert");
      if (nextState === "manage") {
        drawerRoot.setAttribute("role", "dialog");
        drawerRoot.setAttribute("aria-modal", "true");
      } else {
        drawerRoot.setAttribute("role", "region");
        drawerRoot.removeAttribute("aria-modal");
      }
    }

    function settle(nextState, velocity) {
      var target = detents[nextState];
      var reduced = mediaMatches(reducedMotion);
      drawerRoot.classList.remove("is-dragging");
      if (reduced) {
        drawerRoot.classList.remove("is-settling");
        drawerRoot.style.setProperty("--battle-drawer-duration", "0ms");
        setDataset("drawerMotion", "static");
      } else {
        var duration = Math.round(clamp(300 - Math.abs(finite(velocity, 0)) * 12, 180, 300));
        drawerRoot.style.setProperty("--battle-drawer-duration", duration + "ms");
        setDataset("drawerMotion", "spring");
        drawerRoot.classList.add("is-settling");
      }
      setY(target);
    }

    function transitionTo(nextState, velocity) {
      if (destroyed || STATES.indexOf(nextState) === -1 || nextState === stateName) return;
      var previous = stateName;
      var manageFocusTarget = null;
      var closedFocusTarget = null;
      var enteringManage = previous !== "manage" && nextState === "manage";
      if (previous === "closed" && nextState !== "closed") {
        closedFocusReturn = doc && doc.activeElement && !drawerRoot.contains(doc.activeElement)
          ? (returnFocus && isActuallyFocusable(returnFocus) ? returnFocus : doc.activeElement)
          : null;
      }
      if (previous === "manage" && nextState !== "manage") manageFocusTarget = leaveManage(false);
      stateName = nextState;
      paintState(nextState);
      settle(nextState, velocity);
      if (enteringManage) enterManage();
      if (nextState === "closed") {
        closedFocusTarget = closedFocusReturn;
        closedFocusReturn = null;
      }
      onStateChange(nextState);
      if (enteringManage) focusManage();
      else if (previous === "closed" && nextState === "command" && returnFocus && isActuallyFocusable(handle)) handle.focus();
      else if (closedFocusTarget && typeof closedFocusTarget.focus === "function") {
        if (doc.activeElement !== closedFocusTarget) closedFocusTarget.focus();
        if (view && typeof view.setTimeout === "function") view.setTimeout(function () {
          if (!destroyed && stateName === "closed" && isActuallyFocusable(closedFocusTarget)) closedFocusTarget.focus();
        }, 0);
      }
      else if (nextState !== "closed" && manageFocusTarget
          && typeof manageFocusTarget.focus === "function") manageFocusTarget.focus();
    }

    function rubberBand(value, min, max) {
      var limit = 56;
      if (value < min) {
        var above = min - value;
        return min - (limit * above / (limit + above));
      }
      if (value > max) {
        var below = value - max;
        return max + (limit * below / (limit + below));
      }
      return value;
    }

    function isInteractiveTarget(target) {
      if (!target || target === handle || typeof target.closest !== "function") return false;
      return !!target.closest(INTERACTIVE_SELECTOR);
    }

    function eventTime(event) {
      return finite(event && event.timeStamp, Date.now());
    }

    function addPointerTracking() {
      if (pointerTracking) return;
      var target = doc || handle;
      target.addEventListener("pointermove", onPointerMove);
      target.addEventListener("pointerup", onPointerUp);
      target.addEventListener("pointercancel", onPointerCancel);
      pointerTracking = true;
    }

    function removePointerTracking() {
      if (!pointerTracking) return;
      var target = doc || handle;
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
      target.removeEventListener("pointercancel", onPointerCancel);
      pointerTracking = false;
    }

    function onPointerDown(event) {
      if (destroyed || drag || event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
      if (isInteractiveTarget(event.target)) return;
      interruptSettle();
      detents = measure();
      drag = {
        id: event.pointerId,
        startX: finite(event.clientX, 0),
        startY: finite(event.clientY, 0),
        startOffset: currentY,
        engaged: false,
        rejected: false,
        samples: [{ y: finite(event.clientY, 0), t: eventTime(event) }]
      };
      addPointerTracking();
    }

    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.id || drag.rejected) return;
      var x = finite(event.clientX, drag.startX);
      var y = finite(event.clientY, drag.startY);
      var dx = x - drag.startX;
      var dy = y - drag.startY;
      if (!drag.engaged) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) <= 10) return;
        if (Math.abs(dx) >= Math.abs(dy)) {
          var rejectedId = drag.id;
          drag = null;
          removePointerTracking();
          releaseCapture(rejectedId);
          return;
        }
        drag.engaged = true;
        drawerRoot.classList.remove("is-settling");
        drawerRoot.classList.add("is-dragging");
        setDataset("drawerMotion", "drag");
        if (handle.setPointerCapture) {
          try { handle.setPointerCapture(event.pointerId); } catch (_) {}
        }
      }
      setY(rubberBand(drag.startOffset + dy, detents.manage, detents.closed));
      drag.samples.push({ y: y, t: eventTime(event) });
      if (drag.samples.length > 4) drag.samples.shift();
      if (event.preventDefault) event.preventDefault();
    }

    function releaseCapture(pointerId) {
      if (!handle.releasePointerCapture) return;
      try {
        if (!handle.hasPointerCapture || handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      } catch (_) {}
    }

    function releaseVelocity(samples, releaseSample) {
      var recent = (samples || []).concat([releaseSample]).filter(function (sample) {
        return sample.t >= releaseSample.t - 90 && sample.t <= releaseSample.t;
      });
      if (recent.length < 2) return 0;
      var first = recent[0];
      var last = recent[recent.length - 1];
      var elapsed = Math.max(1, last.t - first.t);
      return clamp((last.y - first.y) / elapsed, -4, 4);
    }

    function allowedReleaseStates() {
      if (stateName === "manage") return ["manage", "command"];
      if (stateName === "closed") return ["closed", "command"];
      return STATES;
    }

    function nearestState(projected) {
      return allowedReleaseStates().reduce(function (best, candidate) {
        var distance = Math.abs(detents[candidate] - projected);
        return !best || distance < best.distance ? { state: candidate, distance: distance } : best;
      }, null).state;
    }

    function finishPointer(event, cancelled) {
      if (!drag || event.pointerId !== drag.id) return;
      var finished = drag;
      drag = null;
      removePointerTracking();
      releaseCapture(finished.id);
      drawerRoot.classList.remove("is-dragging");
      if (!finished.engaged || cancelled) {
        if (finished.engaged) settle(stateName, 0);
        return;
      }
      var releaseSample = {
        y: finite(event.clientY, finished.samples[finished.samples.length - 1].y),
        t: eventTime(event)
      };
      var velocity = releaseVelocity(finished.samples, releaseSample);
      var projected = currentY + velocity * 140;
      var nextState = nearestState(projected);
      if (nextState === stateName) settle(stateName, velocity);
      else transitionTo(nextState, velocity);
      if (event.preventDefault) event.preventDefault();
    }

    function onPointerUp(event) { finishPointer(event, false); }
    function onPointerCancel(event) { finishPointer(event, true); }
    function onLostPointerCapture(event) { finishPointer(event, true); }

    function onHandleKeyDown(event) {
      if (destroyed) return;
      var next = null;
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        next = stateName === "closed" ? "command" : (stateName === "command" ? "manage" : "command");
      } else if (event.key === "ArrowUp") next = stateName === "closed" ? "command" : "manage";
      else if (event.key === "ArrowDown") next = stateName === "manage" ? "command" : "closed";
      else if (event.key === "Home") next = "manage";
      else if (event.key === "End") next = "closed";
      else if (event.key === "Escape") next = stateName === "manage" ? "command" : "closed";
      if (!next || next === stateName) return;
      if (event.preventDefault) event.preventDefault();
      transitionTo(next, 0);
    }

    function onDocumentKeyDown(event) {
      if (destroyed || stateName !== "manage") return;
      if (event.key === "Escape") {
        if (event.preventDefault) event.preventDefault();
        transitionTo("command", 0);
        return;
      }
      if (event.key !== "Tab") return;
      var items = focusables();
      if (!items.length) {
        if (event.preventDefault) event.preventDefault();
        if (typeof handle.focus === "function") handle.focus();
        return;
      }
      var first = items[0];
      var last = items[items.length - 1];
      if (event.shiftKey && doc.activeElement === first) {
        if (event.preventDefault) event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        if (event.preventDefault) event.preventDefault();
        first.focus();
      }
    }

    function onTransitionEnd(event) {
      if (!event || !event.propertyName || event.propertyName === "transform") {
        drawerRoot.classList.remove("is-settling");
      }
    }

    function onResize() {
      if (destroyed) return;
      detents = measure();
      drawerRoot.classList.remove("is-settling");
      if (drag) {
        var activeId = drag.id;
        drag = null;
        removePointerTracking();
        releaseCapture(activeId);
        drawerRoot.classList.remove("is-dragging");
        settle(stateName, 0);
      } else {
        setY(detents[stateName]);
      }
    }

    function onMotionPreferenceChange() {
      if (destroyed) return;
      if (mediaMatches(reducedMotion)) {
        drawerRoot.classList.remove("is-settling");
        drawerRoot.style.setProperty("--battle-drawer-duration", "0ms");
        setDataset("drawerMotion", "static");
      }
    }

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("lostpointercapture", onLostPointerCapture);
    handle.addEventListener("keydown", onHandleKeyDown);
    drawerRoot.addEventListener("transitionend", onTransitionEnd);
    if (doc) doc.addEventListener("keydown", onDocumentKeyDown);
    if (view && view.addEventListener) view.addEventListener("resize", onResize);
    if (reducedMotion && reducedMotion.addEventListener) reducedMotion.addEventListener("change", onMotionPreferenceChange);

    if ((!handle.hasAttribute || !handle.hasAttribute("role"))
        && (!handle.matches || !handle.matches(INTERACTIVE_SELECTOR))) {
      handle.setAttribute("role", "button");
    }
    if (drawerRoot.id && (!handle.hasAttribute || !handle.hasAttribute("aria-controls"))) {
      handle.setAttribute("aria-controls", drawerRoot.id);
    }
    if (!handle.hasAttribute || !handle.hasAttribute("tabindex")) handle.setAttribute("tabindex", "0");
    paintState("closed");
    setDataset("drawerMotion", mediaMatches(reducedMotion) ? "static" : "spring");
    drawerRoot.style.setProperty("--battle-drawer-duration", "0ms");
    setY(detents.closed);

    return Object.freeze({
      state: function () { return stateName; },
      openCommand: function () { transitionTo("command", 0); },
      openManage: function () { transitionTo("manage", 0); },
      backToCommand: function () { transitionTo("command", 0); },
      close: function () { transitionTo("closed", 0); },
      destroy: function () {
        if (destroyed) return;
        var destroyFocusReturn = closedFocusReturn || focusReturn;
        destroyed = true;
        var activeId = drag ? drag.id : null;
        drag = null;
        removePointerTracking();
        if (activeId !== null) releaseCapture(activeId);
        leaveManage(true);
        handle.removeEventListener("pointerdown", onPointerDown);
        handle.removeEventListener("lostpointercapture", onLostPointerCapture);
        handle.removeEventListener("keydown", onHandleKeyDown);
        drawerRoot.removeEventListener("transitionend", onTransitionEnd);
        if (doc) doc.removeEventListener("keydown", onDocumentKeyDown);
        if (view && view.removeEventListener) view.removeEventListener("resize", onResize);
        if (reducedMotion && reducedMotion.removeEventListener) reducedMotion.removeEventListener("change", onMotionPreferenceChange);
        if (destroyFocusReturn && doc && drawerRoot.contains(doc.activeElement)
            && typeof destroyFocusReturn.focus === "function") destroyFocusReturn.focus();
        closedFocusReturn = null;

        drawerRoot.classList.toggle("is-dragging", initialDom.rootClasses.dragging);
        drawerRoot.classList.toggle("is-settling", initialDom.rootClasses.settling);
        drawerRoot.inert = initialDom.rootInert;
        restoreAttribute(drawerRoot, "inert", initialDom.rootAttributes.inert);
        restoreAttribute(drawerRoot, "role", initialDom.rootAttributes.role);
        restoreAttribute(drawerRoot, "aria-hidden", initialDom.rootAttributes.ariaHidden);
        restoreAttribute(drawerRoot, "aria-modal", initialDom.rootAttributes.ariaModal);
        restoreDataset(drawerRoot, "drawerState", initialDom.rootDataset.state);
        restoreDataset(drawerRoot, "drawerMotion", initialDom.rootDataset.motion);
        restoreStyle(drawerRoot, "--battle-drawer-y", initialDom.rootStyle.y);
        restoreStyle(drawerRoot, "--battle-drawer-duration", initialDom.rootStyle.duration);

        restoreAttribute(handle, "role", initialDom.handleAttributes.role);
        restoreAttribute(handle, "aria-controls", initialDom.handleAttributes.controls);
        restoreAttribute(handle, "tabindex", initialDom.handleAttributes.tabindex);
        restoreAttribute(handle, "aria-expanded", initialDom.handleAttributes.expanded);
        restoreAttribute(handle, "aria-valuetext", initialDom.handleAttributes.valueText);

        if (background) {
          restoreDataset(background, "drawerBackgroundState", initialDom.backgroundState);
        }
      }
    });
  }

  return Object.freeze({ create: create });
}));
