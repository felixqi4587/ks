(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VirtualList = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var nextListId = 1;

  function finite(value, fallback) {
    value = Number(value);
    return Number.isFinite(value) ? value : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function px(value) {
    var number = parseFloat(value);
    return Number.isFinite(number) ? number : 0;
  }

  function isElement(value) {
    return !!value && typeof value.addEventListener === "function" &&
      typeof value.appendChild === "function" && value.style;
  }

  function captureAttribute(element, name) {
    return {
      present: element.hasAttribute(name),
      value: element.getAttribute(name)
    };
  }

  function restoreAttribute(element, name, snapshot) {
    if (snapshot.present) element.setAttribute(name, snapshot.value === null ? "" : snapshot.value);
    else element.removeAttribute(name);
  }

  function defaultKey(item, index) {
    if (item && item.key != null) return item.key;
    if (item && item.id != null) return item.id;
    if (item && item.pid != null) return item.pid;
    return index;
  }

  function create(options) {
    options = options || {};
    var container = options.container;
    var renderItem = options.renderItem;
    if (!isElement(container)) throw new TypeError("VirtualList requires a container element");
    if (typeof renderItem !== "function") throw new TypeError("VirtualList requires renderItem");

    var doc = container.ownerDocument || (root && root.document) || null;
    if (!doc || typeof doc.createElement !== "function") {
      throw new TypeError("VirtualList requires a container with an ownerDocument");
    }
    var view = doc.defaultView || root || null;
    var getStyle = typeof options.getComputedStyle === "function"
      ? options.getComputedStyle
      : view && typeof view.getComputedStyle === "function"
        ? view.getComputedStyle.bind(view)
        : function () { return {}; };
    var keyFor = typeof options.key === "function" ? options.key : defaultKey;
    var onActivate = typeof options.onActivate === "function" ? options.onActivate : function () {};
    var columnsPolicy = typeof options.columns === "function" ? options.columns : null;
    var overscanRows = Math.max(0, Math.round(finite(options.overscanRows, 3)));
    var minimumRowHeight = Math.max(76, finite(
      typeof options.rowHeight === "number" ? options.rowHeight : 76,
      76
    ));
    var rowHeightOption = typeof options.rowHeight === "function" ? options.rowHeight : null;
    var columnGap = Math.max(0, finite(options.columnGap, 8));
    var baseFontSize = Math.max(1, finite(options.baseFontSize, 16));
    var listId = nextListId++;
    var nextOptionId = 1;
    var destroyed = false;
    var focused = false;
    var items = [];
    var keys = [];
    var indexByKey = new Map();
    var idByKey = new Map();
    var nodesByKey = new Map();
    var measuredHeightByKey = new Map();
    var rowHeights = [];
    var rowOffsets = [0];
    var activeKey = null;
    var metrics = null;
    var resizeObserver = null;

    var initial = {
      role: captureAttribute(container, "role"),
      tabindex: captureAttribute(container, "tabindex"),
      activeDescendant: captureAttribute(container, "aria-activedescendant")
    };

    var canvas = doc.createElement("div");
    canvas.setAttribute("role", "presentation");
    canvas.style.setProperty("position", "relative");
    canvas.style.setProperty("width", "100%");
    canvas.style.setProperty("height", "0px");
    canvas.style.setProperty("overflow-anchor", "none");
    container.appendChild(canvas);
    container.setAttribute("role", "listbox");
    if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "0");
    container.removeAttribute("aria-activedescendant");

    function measure() {
      var style;
      try { style = getStyle(container) || {}; } catch (_) { style = {}; }
      var padding = px(style.paddingLeft) + px(style.paddingRight);
      var width = Math.max(0, finite(container.clientWidth, 0));
      if (width <= 0 && typeof container.getBoundingClientRect === "function") {
        width = Math.max(0, finite(container.getBoundingClientRect().width, 0));
      }
      width = Math.max(0, width - padding);
      var viewportHeight = Math.max(0, finite(container.clientHeight, 0));
      if (viewportHeight <= 0 && typeof container.getBoundingClientRect === "function") {
        viewportHeight = Math.max(0, finite(container.getBoundingClientRect().height, 0));
      }
      var fontSize = Math.max(1, px(style.fontSize) || baseFontSize);
      var textScale = fontSize / baseFontSize;
      var defaultColumns = width >= 360 ? 2 : 1;
      var columns = defaultColumns;
      if (columnsPolicy) {
        try {
          var requestedColumns = columnsPolicy(width, {
            textScale: textScale,
            viewportHeight: viewportHeight,
            defaultColumns: defaultColumns,
            columnGap: columnGap
          });
          columns = typeof requestedColumns === "number" &&
            Number.isFinite(requestedColumns) &&
            (requestedColumns === 1 || requestedColumns === 2)
            ? requestedColumns : 1;
        } catch (_) {
          columns = 1;
        }
      }
      if (textScale > 1.25) columns = 1;
      var densityHeight = textScale >= 1.75 ? 126 : textScale > 1.25 ? 100 : 76;
      var requestedHeight = rowHeightOption ? finite(rowHeightOption({
        width: width,
        viewportHeight: viewportHeight,
        textScale: textScale,
        columns: columns,
        minimum: minimumRowHeight
      }), minimumRowHeight) : minimumRowHeight;
      return {
        width: width,
        viewportHeight: viewportHeight,
        textScale: textScale,
        columns: columns,
        rowHeight: Math.max(minimumRowHeight, densityHeight, requestedHeight),
        columnGap: columnGap
      };
    }

    function itemKey(item, index) {
      return String(keyFor(item, index));
    }

    function rowCount() {
      return metrics && items.length ? Math.ceil(items.length / metrics.columns) : 0;
    }

    function rebuildGeometry() {
      var count = rowCount();
      rowHeights = new Array(count);
      rowOffsets = new Array(count + 1);
      rowOffsets[0] = 0;
      for (var row = 0; row < count; row += 1) {
        var height = metrics.rowHeight;
        var start = row * metrics.columns;
        var end = Math.min(items.length, start + metrics.columns);
        for (var index = start; index < end; index += 1) {
          height = Math.max(height, finite(measuredHeightByKey.get(keys[index]), 0));
        }
        rowHeights[row] = height;
        rowOffsets[row + 1] = rowOffsets[row] + height;
      }
    }

    function totalHeight() {
      return rowOffsets.length ? rowOffsets[rowOffsets.length - 1] : 0;
    }

    function updateCanvasGeometry() {
      canvas.style.setProperty("height", totalHeight() + "px");
    }

    function rowForOffset(offset) {
      var count = rowCount();
      if (!count) return 0;
      offset = clamp(finite(offset, 0), 0, Math.max(0, totalHeight() - 0.001));
      var low = 0;
      var high = count;
      while (low < high) {
        var middle = Math.floor((low + high) / 2);
        if (rowOffsets[middle + 1] <= offset) low = middle + 1;
        else high = middle;
      }
      return clamp(low, 0, count - 1);
    }

    function snapshotAtIndex(index, offset) {
      if (index < 0 || index >= keys.length) return null;
      return {
        key: keys[index],
        index: index,
        offset: finite(offset, 0),
        nextKeys: keys.slice(index + 1),
        previousKeys: keys.slice(0, index).reverse()
      };
    }

    function currentAnchor() {
      if (!items.length || !metrics) return null;
      var scrollTop = Math.max(0, finite(container.scrollTop, 0));
      var row = rowForOffset(scrollTop);
      var index = clamp(row * metrics.columns, 0, items.length - 1);
      return snapshotAtIndex(index, scrollTop - rowOffsets[row]);
    }

    function resolveSnapshotKey(snapshot) {
      if (!snapshot) return null;
      if (indexByKey.has(snapshot.key)) return snapshot.key;
      var lists = [snapshot.nextKeys || [], snapshot.previousKeys || []];
      for (var listIndex = 0; listIndex < lists.length; listIndex += 1) {
        for (var index = 0; index < lists[listIndex].length; index += 1) {
          if (indexByKey.has(lists[listIndex][index])) return lists[listIndex][index];
        }
      }
      return null;
    }

    function setScrollTop(value) {
      var maximum = Math.max(0, totalHeight() - metrics.viewportHeight);
      container.scrollTop = clamp(finite(value, 0), 0, maximum);
    }

    function restoreAnchor(anchor) {
      if (!anchor || !metrics || !items.length) {
        setScrollTop(0);
        return;
      }
      var key = resolveSnapshotKey(anchor);
      if (key === null) {
        setScrollTop(0);
        return;
      }
      var index = indexByKey.get(key);
      var row = Math.floor(index / metrics.columns);
      var height = rowHeights[row] || metrics.rowHeight;
      setScrollTop(rowOffsets[row] + clamp(anchor.offset, 0, Math.max(0, height - 1)));
    }

    function optionId(key) {
      if (!idByKey.has(key)) {
        idByKey.set(key, "virtual-list-" + listId + "-option-" + nextOptionId++);
      }
      return idByKey.get(key);
    }

    function createOption(key) {
      var node = doc.createElement("div");
      node.setAttribute("id", optionId(key));
      node.setAttribute("role", "option");
      node.setAttribute("tabindex", "-1");
      node.style.setProperty("position", "absolute");
      node.style.setProperty("top", "0");
      node.style.setProperty("left", "0");
      node.style.setProperty("box-sizing", "border-box");
      canvas.appendChild(node);
      nodesByKey.set(key, node);
      if (resizeObserver) resizeObserver.observe(node);
      return node;
    }

    function desiredIndexes() {
      var desired = [];
      if (!items.length || !metrics) return desired;
      var count = rowCount();
      var scrollTop = Math.max(0, finite(container.scrollTop, 0));
      var firstVisibleRow = rowForOffset(scrollTop);
      var viewportEnd = scrollTop + Math.max(0, metrics.viewportHeight - 0.001);
      var lastVisibleRow = metrics.viewportHeight > 0 ? rowForOffset(viewportEnd) : firstVisibleRow;
      var startRow = Math.max(0, firstVisibleRow - overscanRows);
      var endRow = Math.min(count, lastVisibleRow + 1 + overscanRows);
      for (var row = startRow; row < endRow; row += 1) {
        var start = row * metrics.columns;
        var end = Math.min(items.length, start + metrics.columns);
        for (var index = start; index < end; index += 1) desired.push(index);
      }
      if (focused && activeKey !== null && indexByKey.has(activeKey)) {
        var activeIndex = indexByKey.get(activeKey);
        if (desired.indexOf(activeIndex) < 0) desired.push(activeIndex);
      }
      return desired;
    }

    function updateActiveDescendant() {
      if (!focused || activeKey === null || !nodesByKey.has(activeKey)) {
        container.removeAttribute("aria-activedescendant");
        return;
      }
      container.setAttribute("aria-activedescendant", nodesByKey.get(activeKey).getAttribute("id"));
    }

    function measuredNodeHeight(node) {
      var rectangleHeight = 0;
      if (typeof node.getBoundingClientRect === "function") {
        try { rectangleHeight = finite(node.getBoundingClientRect().height, 0); } catch (_) {}
      }
      return Math.max(metrics.rowHeight, Math.ceil(Math.max(
        rectangleHeight,
        finite(node.offsetHeight, 0),
        finite(node.scrollHeight, 0)
      )));
    }

    function recordMeasurements(nodes) {
      var changed = false;
      nodes.forEach(function (node) {
        var key = node._virtualListKey;
        if (key == null || !indexByKey.has(key)) return;
        var height = measuredNodeHeight(node);
        var previous = measuredHeightByKey.get(key);
        if (previous == null || Math.abs(previous - height) >= 0.5) {
          measuredHeightByKey.set(key, height);
          changed = true;
        }
      });
      return changed;
    }

    function render(reconcileFocusedActive, scrollIntent) {
      if (destroyed) return false;
      if (!metrics) metrics = measure();
      var changed = false;
      var viewportChanged = false;
      var iteration = 0;
      do {
        viewportChanged = false;
        updateCanvasGeometry();
        var indexes = desiredIndexes();
        if (scrollIntent && indexByKey.has(scrollIntent.key)) {
          var intentIndex = indexByKey.get(scrollIntent.key);
          if (indexes.indexOf(intentIndex) < 0) indexes.push(intentIndex);
        }
        var desiredKeys = new Set(indexes.map(function (index) { return keys[index]; }));

        nodesByKey.forEach(function (node, key) {
          if (desiredKeys.has(key)) return;
          if (resizeObserver && typeof resizeObserver.unobserve === "function") resizeObserver.unobserve(node);
          if (typeof node.remove === "function") node.remove();
          else if (node.parentNode) node.parentNode.removeChild(node);
          nodesByKey.delete(key);
        });

        var columns = metrics.columns;
        var itemWidth = columns > 0
          ? Math.max(0, (metrics.width - metrics.columnGap * (columns - 1)) / columns)
          : metrics.width;
        var measuredNodes = [];
        indexes.forEach(function (index) {
          var key = keys[index];
          var item = items[index];
          var node = nodesByKey.get(key) || createOption(key);
          var row = Math.floor(index / columns);
          var column = index % columns;
          node._virtualListKey = key;
          node.setAttribute("aria-posinset", String(index + 1));
          node.setAttribute("aria-setsize", String(items.length));
          node.setAttribute("aria-selected", key === activeKey ? "true" : "false");
          node.style.setProperty("width", itemWidth + "px");
          node.style.setProperty("min-height", metrics.rowHeight + "px");
          node.style.setProperty("transform", "translate3d(" +
            (column * (itemWidth + metrics.columnGap)) + "px, " +
            rowOffsets[row] + "px, 0)");
          if (node._virtualListItem !== item || node._virtualListIndex !== index) {
            renderItem(node, item, index);
            node._virtualListItem = item;
            node._virtualListIndex = index;
          }
          measuredNodes.push(node);
        });

        var anchor = currentAnchor();
        changed = recordMeasurements(measuredNodes);
        if (changed) {
          rebuildGeometry();
          updateCanvasGeometry();
          restoreAnchor(anchor);
        } else if (scrollIntent && indexByKey.has(scrollIntent.key)) {
          var previousIntentScrollTop = Math.max(0, finite(container.scrollTop, 0));
          setIndexIntoView(indexByKey.get(scrollIntent.key), scrollIntent.align);
          viewportChanged = Math.abs(previousIntentScrollTop - finite(container.scrollTop, 0)) >= 0.5;
        } else if (reconcileFocusedActive && focused && activeKey !== null && indexByKey.has(activeKey)) {
          var previousScrollTop = Math.max(0, finite(container.scrollTop, 0));
          setActiveIntoView(indexByKey.get(activeKey));
          viewportChanged = Math.abs(previousScrollTop - finite(container.scrollTop, 0)) >= 0.5;
        }
        iteration += 1;
      } while ((changed || viewportChanged) && iteration < 8);
      updateActiveDescendant();
      return true;
    }

    function visibleStartIndex() {
      if (!items.length || !metrics) return -1;
      var row = rowForOffset(Math.max(0, finite(container.scrollTop, 0)));
      return clamp(row * metrics.columns, 0, items.length - 1);
    }

    function setIndexIntoView(index, align) {
      if (!metrics || index < 0 || index >= items.length) return false;
      var row = Math.floor(index / metrics.columns);
      var top = rowOffsets[row];
      var height = rowHeights[row] || metrics.rowHeight;
      var bottom = top + height;
      var current = Math.max(0, finite(container.scrollTop, 0));
      var next = current;
      if (align === "start") next = top;
      else if (align === "center") next = top - Math.max(0, metrics.viewportHeight - height) / 2;
      else if (align === "end") next = bottom - metrics.viewportHeight;
      else if (top < current) next = top;
      else if (bottom > current + metrics.viewportHeight) next = bottom - metrics.viewportHeight;
      setScrollTop(next);
      return true;
    }

    function setActiveIntoView(index) {
      if (!metrics || index < 0 || index >= items.length) return false;
      var row = Math.floor(index / metrics.columns);
      var top = rowOffsets[row];
      var bottom = top + (rowHeights[row] || metrics.rowHeight);
      var current = Math.max(0, finite(container.scrollTop, 0));
      if (bottom > current && top < current + metrics.viewportHeight) return true;
      return setIndexIntoView(index);
    }

    function scrollIndexIntoView(index, align, reconcileFocusedActive, scrollIntent) {
      if (!setIndexIntoView(index, align)) return false;
      render(!!reconcileFocusedActive, scrollIntent || null);
      return true;
    }

    function setActiveIndex(index, ensureVisible) {
      if (!items.length) {
        activeKey = null;
        render();
        return false;
      }
      index = clamp(index, 0, items.length - 1);
      activeKey = keys[index];
      if (ensureVisible) scrollIndexIntoView(index, null, true);
      else render();
      return true;
    }

    function activate(event) {
      if (activeKey === null || !indexByKey.has(activeKey)) return false;
      var index = indexByKey.get(activeKey);
      onActivate(items[index], index, event);
      return true;
    }

    function onFocus() {
      if (destroyed) return;
      focused = true;
      if (activeKey === null || !indexByKey.has(activeKey)) setActiveIndex(visibleStartIndex(), false);
      else render();
    }

    function onFocusOut(event) {
      if (destroyed || (event.relatedTarget && container.contains(event.relatedTarget))) return;
      focused = false;
      container.removeAttribute("aria-activedescendant");
      render();
    }

    function onScroll() { render(); }

    function onKeyDown(event) {
      if (destroyed || !items.length) return;
      var current = activeKey !== null && indexByKey.has(activeKey)
        ? indexByKey.get(activeKey) : visibleStartIndex();
      var next = null;
      var firstRow = rowForOffset(Math.max(0, finite(container.scrollTop, 0)));
      var lastRow = metrics.viewportHeight > 0
        ? rowForOffset(Math.max(0, finite(container.scrollTop, 0)) + metrics.viewportHeight - 0.001)
        : firstRow;
      var pageSize = Math.max(1, (lastRow - firstRow + 1) * metrics.columns);
      if (event.key === "ArrowDown") next = current + 1;
      else if (event.key === "ArrowUp") next = current - 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      else if (event.key === "PageDown") next = current + pageSize;
      else if (event.key === "PageUp") next = current - pageSize;
      else if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        if (event.preventDefault) event.preventDefault();
        activate(event);
        return;
      } else return;
      if (event.preventDefault) event.preventDefault();
      setActiveIndex(next, true);
    }

    function optionFromTarget(target) {
      var current = target;
      while (current && current !== container) {
        if (current._virtualListKey != null) return current;
        current = current.parentNode;
      }
      return null;
    }

    function onClick(event) {
      if (destroyed) return;
      var node = optionFromTarget(event.target);
      if (!node || !indexByKey.has(node._virtualListKey)) return;
      if (doc.activeElement !== container && typeof container.focus === "function") container.focus();
      focused = true;
      setActiveIndex(indexByKey.get(node._virtualListKey), false);
      activate(event);
    }

    function setItems(nextItems) {
      if (destroyed) return false;
      var anchor = currentAnchor();
      var activeSnapshot = activeKey !== null && indexByKey.has(activeKey)
        ? snapshotAtIndex(indexByKey.get(activeKey), 0) : null;
      var previousIndex = indexByKey;
      var candidateItems = Array.isArray(nextItems) ? nextItems.slice() : [];
      var candidateKeys = [];
      var candidateIndex = new Map();
      candidateItems.forEach(function (item, index) {
        var key = itemKey(item, index);
        if (candidateIndex.has(key)) throw new TypeError("VirtualList item keys must be unique");
        candidateKeys.push(key);
        candidateIndex.set(key, index);
      });
      var nextMeasuredHeights = new Map();
      candidateKeys.forEach(function (key) {
        if (!previousIndex.has(key)) return;
        if (measuredHeightByKey.has(key)) {
          nextMeasuredHeights.set(key, measuredHeightByKey.get(key));
        }
      });
      items = candidateItems;
      keys = candidateKeys;
      indexByKey = candidateIndex;
      measuredHeightByKey = nextMeasuredHeights;
      if (activeKey !== null && !indexByKey.has(activeKey)) {
        activeKey = focused ? resolveSnapshotKey(activeSnapshot) : null;
      }
      if (!items.length) activeKey = null;
      rebuildGeometry();
      updateCanvasGeometry();
      restoreAnchor(anchor);
      if (focused && items.length) {
        if (activeKey === null || !indexByKey.has(activeKey)) {
          var visible = visibleStartIndex();
          activeKey = visible >= 0 ? keys[visible] : keys[0];
        }
        setActiveIntoView(indexByKey.get(activeKey));
      }
      render(true);
      return true;
    }

    function scrollToKey(rawKey, align) {
      if (destroyed) return false;
      var key = String(rawKey);
      if (!indexByKey.has(key)) return false;
      return scrollIndexIntoView(indexByKey.get(key), align, false, { key: key, align: align });
    }

    function metricsEqual(left, right) {
      return !!left && !!right &&
        left.width === right.width &&
        left.viewportHeight === right.viewportHeight &&
        left.textScale === right.textScale &&
        left.columns === right.columns &&
        left.rowHeight === right.rowHeight &&
        left.columnGap === right.columnGap;
    }

    function remeasureWith(nextMetrics) {
      var anchor = currentAnchor();
      var previousMetrics = metrics;
      var layoutChanged = !previousMetrics ||
        previousMetrics.width !== nextMetrics.width ||
        previousMetrics.textScale !== nextMetrics.textScale ||
        previousMetrics.columns !== nextMetrics.columns ||
        previousMetrics.rowHeight !== nextMetrics.rowHeight;
      metrics = nextMetrics;
      if (layoutChanged) measuredHeightByKey.clear();
      rebuildGeometry();
      updateCanvasGeometry();
      restoreAnchor(anchor);
      render();
      return true;
    }

    function remeasure() {
      if (destroyed) return false;
      return remeasureWith(measure());
    }

    function onResize(entries) {
      if (destroyed) return;
      var observedMetrics = measure();
      if (!metricsEqual(metrics, observedMetrics) || !Array.isArray(entries) ||
          entries.some(function (entry) { return entry.target === container; })) {
        remeasureWith(observedMetrics);
        return;
      }
      var nodes = entries.map(function (entry) { return entry.target; }).filter(function (node) {
        return node && node._virtualListKey != null && nodesByKey.get(node._virtualListKey) === node;
      });
      if (!nodes.length) return;
      var anchor = currentAnchor();
      if (!recordMeasurements(nodes)) return;
      rebuildGeometry();
      updateCanvasGeometry();
      restoreAnchor(anchor);
      render();
    }

    container.addEventListener("focus", onFocus);
    container.addEventListener("focusout", onFocusOut);
    container.addEventListener("scroll", onScroll);
    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("click", onClick);
    var ResizeObserverValue = options.ResizeObserver || (root && root.ResizeObserver);
    if (typeof ResizeObserverValue === "function") {
      resizeObserver = new ResizeObserverValue(onResize);
      resizeObserver.observe(container);
    } else if (view && typeof view.addEventListener === "function") {
      view.addEventListener("resize", onResize);
    }

    metrics = measure();
    rebuildGeometry();
    render();

    return Object.freeze({
      setItems: setItems,
      scrollToKey: scrollToKey,
      remeasure: remeasure,
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        container.removeEventListener("focus", onFocus);
        container.removeEventListener("focusout", onFocusOut);
        container.removeEventListener("scroll", onScroll);
        container.removeEventListener("keydown", onKeyDown);
        container.removeEventListener("click", onClick);
        if (resizeObserver) resizeObserver.disconnect();
        else if (view && typeof view.removeEventListener === "function") {
          view.removeEventListener("resize", onResize);
        }
        nodesByKey.clear();
        if (typeof canvas.remove === "function") canvas.remove();
        else if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        restoreAttribute(container, "role", initial.role);
        restoreAttribute(container, "tabindex", initial.tabindex);
        restoreAttribute(container, "aria-activedescendant", initial.activeDescendant);
      }
    });
  }

  return Object.freeze({ create: create });
}));
