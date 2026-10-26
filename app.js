/* Images to PDF — pdf-lib (Andrew Dillon, MIT) builds the PDF; images are decoded with the browser's own canvas. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$, h = S3.h, PDFDocument = PDFLib.PDFDocument;
  var MM = 72 / 25.4, SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
  var QUALITY = { original: null, high: { q: 0.9, max: 3000 }, medium: { q: 0.75, max: 2000 }, small: { q: 0.6, max: 1400 } };
  var saved = S3.store("img2pdf") || {};
  var o = { size: saved.size || "a4", orient: saved.orient || "auto", margin: saved.margin == null ? 10 : saved.margin, quality: saved.quality || "high" };
  var items = [], uid = 0, dragFrom = -1;

  // ---------- EXIF orientation (1-8) of a JPEG, 1 when absent ----------
  function exifOrientation(b) {
    if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return 1;
    var i = 2;
    while (i + 4 < b.length) {
      if (b[i] !== 0xFF) return 1;
      var marker = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (marker === 0xE1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
        var t = i + 10, le = b[t] === 0x49;
        var u16 = function (p) { return le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]; };
        var u32 = function (p) { return le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 16777216 : b[p] * 16777216 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]); };
        var ifd = t + u32(t + 4), n = u16(ifd);
        for (var k = 0; k < n; k++) { var e = ifd + 2 + k * 12; if (e + 10 > b.length) break; if (u16(e) === 0x0112) { var v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; } }
        return 1;
      }
      if (marker === 0xDA) return 1; // image data starts: no EXIF before it
      i += 2 + len;
    }
    return 1;
  }
  function sniff(b) {
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "jpg";
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "png";
    return "other";
  }

  // ---------- turn one image into embeddable bytes ----------
  function decode(it) {
    return createImageBitmap(it.file).catch(function () {
      return new Promise(function (res, rej) { // fallback for formats createImageBitmap rejects (e.g. some SVGs)
        var url = URL.createObjectURL(it.file), im = new Image();
        im.onload = function () { res(im); }; im.onerror = function () { rej(new Error("This browser can't open " + it.name)); };
        im.src = url;
      });
    });
  }
  function prepare(it, quality) {
    var b = it.bytes, kind = sniff(b), q = QUALITY[quality];
    if (!q && !it.rot && kind === "png") return Promise.resolve({ kind: "png", bytes: b, w: it.w, h: it.h });
    if (!q && !it.rot && kind === "jpg" && exifOrientation(b) === 1) return Promise.resolve({ kind: "jpg", bytes: b, w: it.w, h: it.h });
    return decode(it).then(function (bmp) {
      var sw = bmp.width, sh = bmp.height, k = q ? Math.min(1, q.max / Math.max(sw, sh)) : 1;
      var w = Math.round(sw * k), hh = Math.round(sh * k), side = it.rot % 180 !== 0;
      var c = document.createElement("canvas"); c.width = side ? hh : w; c.height = side ? w : hh;
      var x = c.getContext("2d");
      x.translate(c.width / 2, c.height / 2); x.rotate(it.rot * Math.PI / 180);
      var alpha = !q && kind !== "jpg" && hasAlpha(bmp);
      if (!alpha) { x.fillStyle = "#fff"; x.fillRect(-c.width, -c.height, c.width * 2, c.height * 2); }
      x.drawImage(bmp, -w / 2, -hh / 2, w, hh);
      if (bmp.close) bmp.close();
      var type = alpha ? "image/png" : "image/jpeg";
      return new Promise(function (res, rej) {
        c.toBlob(function (blob) {
          if (!blob) { rej(new Error("Couldn't encode " + it.name)); return; }
          blob.arrayBuffer().then(function (a) { res({ kind: alpha ? "png" : "jpg", bytes: new Uint8Array(a), w: c.width, h: c.height }); });
        }, type, q ? q.q : 0.92);
      });
    });
  }
  function hasAlpha(bmp) {
    var s = 64, c = document.createElement("canvas"); c.width = c.height = s;
    var x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(bmp, 0, 0, s, s);
    var d = x.getImageData(0, 0, s, s).data;
    for (var i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    return false;
  }

  // ---------- page geometry (points) ----------
  function pageFor(w, hh, opt) {
    var m = opt.margin * MM, pw, ph;
    if (opt.size === "fit") {
      var k = Math.min(0.75, 14000 / Math.max(w, hh)); // 96 dpi, capped below the PDF page limit
      pw = w * k + 2 * m; ph = hh * k + 2 * m;
    } else {
      var s = SIZES[opt.size], land = opt.orient === "landscape" || (opt.orient === "auto" && w > hh);
      pw = land ? s[1] : s[0]; ph = land ? s[0] : s[1];
    }
    var aw = Math.max(1, pw - 2 * m), ah = Math.max(1, ph - 2 * m), sc = Math.min(aw / w, ah / hh);
    var dw = w * sc, dh = hh * sc;
    return { pw: pw, ph: ph, x: (pw - dw) / 2, y: (ph - dh) / 2, w: dw, h: dh };
  }
  function build(prepared, opt) {
    return PDFDocument.create().then(function (doc) {
      return prepared.reduce(function (p, im) {
        return p.then(function () {
          return (im.kind === "png" ? doc.embedPng(im.bytes) : doc.embedJpg(im.bytes)).then(function (img) {
            var g = pageFor(im.w, im.h, opt), page = doc.addPage([g.pw, g.ph]);
            page.drawImage(img, { x: g.x, y: g.y, width: g.w, height: g.h });
          });
        });
      }, Promise.resolve()).then(function () { doc.setProducer("S3eidat Tools Images to PDF"); doc.setCreator("S3eidat Tools"); return doc.save(); });
    });
  }

  // ---------- UI ----------
  function save() { S3.store("img2pdf", o); }
  function seg(el, value, onPick) {
    $$("button", el).forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.v === value));
      b.addEventListener("click", function () { $$("button", el).forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); onPick(b.dataset.v); });
    });
  }
  seg($("#size"), o.size, function (v) { o.size = v; save(); syncOpts(); });
  seg($("#orient"), o.orient, function (v) { o.orient = v; save(); });
  function syncOpts() { $("#orientWrap").classList.toggle("off", o.size === "fit"); $$("#orient button").forEach(function (b) { b.disabled = o.size === "fit"; }); }
  $("#margin").value = o.margin; $("#marginVal").textContent = o.margin;
  $("#margin").addEventListener("input", function (e) { o.margin = +e.target.value; $("#marginVal").textContent = o.margin; save(); });
  $("#quality").value = o.quality; $("#quality").addEventListener("change", function (e) { o.quality = e.target.value; save(); });
  syncOpts();

  function addFiles(files) {
    files.forEach(function (f) {
      var it = { id: ++uid, file: f, name: f.name || "pasted image", size: f.size, url: URL.createObjectURL(f), rot: 0, w: 0, h: 0, bytes: null, error: "" };
      items.push(it);
      S3.readFile(f).then(function (a) { it.bytes = new Uint8Array(a); return decode(it); })
        .then(function (bmp) { it.w = bmp.width; it.h = bmp.height; if (bmp.close) bmp.close(); })
        .catch(function () { it.error = "Can't read this image"; })
        .then(draw);
    });
    draw();
  }
  S3.drop($("#drop"), addFiles, { accept: "image/*", multiple: true });
  document.addEventListener("paste", function (e) {
    var fs = []; Array.prototype.forEach.call((e.clipboardData && e.clipboardData.items) || [], function (i) { if (i.kind === "file" && /^image\//.test(i.type)) fs.push(i.getAsFile()); });
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  });

  function move(from, to) { if (to < 0 || to >= items.length || from === to) return; items.splice(to, 0, items.splice(from, 1)[0]); draw(); }
  function draw() {
    var grid = $("#grid"); grid.innerHTML = "";
    items.forEach(function (it, i) {
      var img = h("img", { src: it.url, alt: it.name, draggable: "false", style: "transform: rotate(" + it.rot + "deg)" + (it.rot % 180 ? " scale(" + (it.w && it.h ? Math.min(it.w, it.h) / Math.max(it.w, it.h) : 1) + ")" : "") });
      grid.appendChild(h("div", { "class": "ip-tile" + (it.error ? " err" : ""), draggable: "true", "data-i": i }, [
        h("div", { "class": "ip-thumb" }, [img, h("span", { "class": "ip-num", text: String(i + 1) })]),
        h("div", { "class": "ip-name", title: it.name, text: it.name }),
        h("div", { "class": it.error ? "ip-err" : "faint ip-meta", text: it.error || (it.w ? it.w + "×" + it.h + " · " + S3.fmtBytes(it.size) : "Reading…") }),
        h("div", { "class": "ip-acts" }, [
          h("button", { "class": "btn ghost icon small", "aria-label": "Move " + it.name + " earlier", title: "Move earlier", disabled: i === 0, onclick: function () { move(i, i - 1); } }, ["◀"]),
          h("button", { "class": "btn ghost icon small", "aria-label": "Rotate " + it.name, title: "Rotate 90°", onclick: function () { it.rot = (it.rot + 90) % 360; draw(); } }, ["⟳"]),
          h("button", { "class": "btn ghost icon small", "aria-label": "Move " + it.name + " later", title: "Move later", disabled: i === items.length - 1, onclick: function () { move(i, i + 1); } }, ["▶"]),
          h("button", { "class": "btn ghost icon small danger", "aria-label": "Remove " + it.name, title: "Remove", onclick: function () { URL.revokeObjectURL(it.url); items.splice(i, 1); draw(); } }, ["✕"])
        ])
      ]));
    });
    var ok = items.filter(function (x) { return x.w && !x.error; }).length, loading = items.some(function (x) { return !x.w && !x.error; });
    $("#listHead").hidden = $("#tip").hidden = !items.length;
    $("#drop").classList.toggle("compact", !!items.length);
    $("#count").textContent = items.length ? ok + " image" + (ok === 1 ? "" : "s") : "";
    $("#make").disabled = !ok || loading;
  }
  $("#clear").addEventListener("click", function () { items.forEach(function (x) { URL.revokeObjectURL(x.url); }); items = []; $("#result").textContent = ""; draw(); });
  $("#sortName").addEventListener("click", function () { items.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); }); draw(); });

  var grid = $("#grid");
  grid.addEventListener("dragstart", function (e) { var t = e.target.closest && e.target.closest(".ip-tile"); if (!t) return; dragFrom = +t.dataset.i; t.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", t.dataset.i); } catch (x) { /* ignore */ } });
  grid.addEventListener("dragover", function (e) {
    if (dragFrom < 0) return; e.preventDefault();
    $$(".ip-tile", grid).forEach(function (x) { x.classList.remove("ins-l", "ins-r"); });
    var t = e.target.closest(".ip-tile"); if (!t) return;
    var r = t.getBoundingClientRect(); t.classList.add(e.clientX < r.left + r.width / 2 ? "ins-l" : "ins-r");
  });
  grid.addEventListener("drop", function (e) {
    if (dragFrom < 0) return; e.preventDefault(); e.stopPropagation();
    var t = e.target.closest(".ip-tile"), from = dragFrom; dragFrom = -1;
    if (!t) { draw(); return; }
    var r = t.getBoundingClientRect(), to = +t.dataset.i + (e.clientX >= r.left + r.width / 2 ? 1 : 0);
    move(from, to > from ? to - 1 : to);
  });
  grid.addEventListener("dragend", function () { dragFrom = -1; $$(".ip-tile", grid).forEach(function (x) { x.classList.remove("dragging", "ins-l", "ins-r"); }); });

  $("#make").addEventListener("click", function () {
    var list = items.filter(function (x) { return x.w && !x.error; }), btn = this, t0 = performance.now();
    if (!list.length) return;
    btn.disabled = true;
    var done = 0, prepared = [];
    list.reduce(function (p, it) {
      return p.then(function () {
        $("#result").textContent = "Preparing image " + (++done) + " of " + list.length + "…";
        return prepare(it, o.quality).then(function (r) { prepared.push(r); });
      });
    }, Promise.resolve()).then(function () {
      $("#result").textContent = "Building PDF…";
      return build(prepared, o);
    }).then(function (bytes) {
      var name = ($("#outName").value.trim() || "images.pdf").replace(/[\\/:*?"<>|]+/g, "_");
      if (!/\.pdf$/i.test(name)) name += ".pdf";
      S3.download(new Blob([bytes], { type: "application/pdf" }), name);
      $("#result").textContent = "Done: " + list.length + " page" + (list.length > 1 ? "s" : "") + ", " + S3.fmtBytes(bytes.length) + ", in " + Math.max(0.1, (performance.now() - t0) / 1000).toFixed(1) + " s.";
      S3.done();
    }).catch(function (e) { $("#result").textContent = ""; S3.toast("Couldn't create the PDF: " + (e && e.message || e), "error"); })
      .then(function () { btn.disabled = false; });
  });

  // ---------- sample images, drawn here ----------
  function sampleImage(w, hh, hue, label, type) {
    var c = document.createElement("canvas"); c.width = w; c.height = hh;
    var x = c.getContext("2d"), g = x.createLinearGradient(0, 0, w, hh);
    g.addColorStop(0, "hsl(" + hue + " 70% 62%)"); g.addColorStop(1, "hsl(" + (hue + 50) + " 70% 38%)");
    x.fillStyle = g; x.fillRect(0, 0, w, hh);
    x.fillStyle = "rgba(255,255,255,.18)";
    for (var i = 0; i < 7; i++) { x.beginPath(); x.arc(w * ((i * 37) % 100) / 100, hh * ((i * 59) % 100) / 100, Math.min(w, hh) * (0.08 + i * 0.03), 0, 7); x.fill(); }
    x.fillStyle = "#fff"; x.font = "700 " + Math.round(Math.min(w, hh) / 7) + "px Inter, sans-serif"; x.textAlign = "center"; x.fillText(label, w / 2, hh / 2);
    return new Promise(function (res) { c.toBlob(function (b) { res(new File([b], label.toLowerCase().replace(/\s+/g, "-") + (type === "image/png" ? ".png" : ".jpg"), { type: type })); }, type, 0.9); });
  }
  window.S3_DEMO = function () {
    return Promise.all([sampleImage(1200, 1600, 170, "Receipt", "image/jpeg"), sampleImage(1600, 1000, 260, "Whiteboard", "image/jpeg"), sampleImage(1000, 1400, 15, "Page 3", "image/png"), sampleImage(1400, 1400, 40, "Diagram", "image/png"), sampleImage(1200, 1600, 200, "Notes", "image/jpeg")])
      .then(function (files) { addFiles(files); return new Promise(function (r) { setTimeout(r, 500); }); });
  };

  // Self-test: real images in, PDF out; check page count, sizes and orientation; plus the EXIF parser.
  window.S3_SELFTEST = function () {
    var exif = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,
      0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xD9]);
    var mk = function (w, hh, type) { return sampleImage(w, hh, 120, "T", type).then(function (f) { return f.arrayBuffer().then(function (a) { return { file: f, name: f.name, bytes: new Uint8Array(a), w: w, h: hh, rot: 0 }; }); }); };
    return Promise.all([mk(300, 200, "image/jpeg"), mk(200, 300, "image/png"), mk(100, 100, "image/jpeg")]).then(function (its) {
      its[2].rot = 90;
      return Promise.all(its.map(function (it) { return prepare(it, "original"); })).then(function (prep) {
        return Promise.all([build(prep, { size: "a4", orient: "auto", margin: 10 }), build(prep.slice(0, 1), { size: "fit", orient: "auto", margin: 0 })]).then(function (pdfs) {
          return Promise.all([PDFDocument.load(pdfs[0]), PDFDocument.load(pdfs[1])]).then(function (docs) {
            var s = docs[0].getPages().map(function (p) { return Math.round(p.getWidth()) + "x" + Math.round(p.getHeight()); }).join();
            var f = docs[1].getPage(0).getSize();
            var g = pageFor(300, 200, { size: "a4", orient: "auto", margin: 10 });
            return s === "842x595,595x842,595x842" && Math.round(f.width) === 225 && Math.round(f.height) === 150 &&
              prep[0].bytes === its[0].bytes && prep[1].kind === "png" && prep[2].kind === "jpg" &&
              Math.abs(g.x - 10 * MM) < 0.01 && exifOrientation(exif) === 6 && exifOrientation(new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0, 2])) === 1;
          });
        });
      });
    });
  };
})();
