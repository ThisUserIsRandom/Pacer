/* Pacer — Tab 3: Analytics dashboard (Chart.js colourful bar graphs). */
(function () {
  'use strict';

  const Pacer = (window.Pacer = window.Pacer || {});

  /** Pastel rainbow palette cycled across bars. */
  const PALETTE = [
    '#A7F3D0',
    '#BFDBFE',
    '#DDD6FE',
    '#FDE68A',
    '#FDBA74',
    '#FDA4AF',
    '#FBCFE8',
    '#99F6E4'
  ];

  const PALETTE_STRONG = [
    '#34D399',
    '#60A5FA',
    '#A78BFA',
    '#FBBF24',
    '#FB923C',
    '#FB7185',
    '#F472B6',
    '#2DD4BF'
  ];

  const el = {};
  const charts = { wpm: null, accuracy: null, errors: null };
  /** How many recent sessions to plot; totals always cover all history. */
  const CHART_WINDOW = 120;
  let dirty = true;
  let loading = false;

  function cacheElements() {
    el.sessions = document.getElementById('stat-sessions');
    el.typingBest = document.getElementById('stat-typing-best');
    el.typingAvg = document.getElementById('stat-typing-avg');
    el.accuracy = document.getElementById('stat-accuracy');
    el.readingAvg = document.getElementById('stat-reading-avg');
    el.minutes = document.getElementById('stat-minutes');
    el.empty = document.getElementById('analytics-empty');
    el.charts = document.getElementById('analytics-charts');
    el.refresh = document.getElementById('analytics-refresh');
    el.clear = document.getElementById('analytics-clear');
    el.note = document.getElementById('analytics-note');
    el.backend = document.getElementById('analytics-backend');
  }

  function hasChartJs() {
    return typeof window.Chart !== 'undefined';
  }

  function barColors(count, strong) {
    const source = strong ? PALETTE_STRONG : PALETTE;
    const colors = [];
    for (let i = 0; i < count; i += 1) colors.push(source[i % source.length]);
    return colors;
  }

  function baseOptions(label) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(75,68,83,.92)',
          padding: 10,
          cornerRadius: 10,
          displayColors: false,
          titleFont: { family: 'Poppins', size: 12 },
          bodyFont: { family: 'Quicksand', size: 13 }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#948ca6', font: { family: 'Quicksand', size: 11 } },
          title: { display: true, text: label, color: '#948ca6', font: { family: 'Poppins', size: 11 } }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(124,110,166,.12)' },
          border: { display: false },
          ticks: { color: '#948ca6', font: { family: 'Quicksand', size: 11 } }
        }
      }
    };
  }

  /** Destroy + recreate so switching tabs never reuses a stale canvas. */
  function drawChart(key, canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    if (charts[key]) {
      charts[key].destroy();
      charts[key] = null;
    }
    charts[key] = new window.Chart(canvas.getContext('2d'), config);
  }

  function renderCharts(sessions) {
    if (!hasChartJs()) {
      el.charts.hidden = true;
      el.empty.hidden = false;
      el.empty.querySelector('strong').textContent = 'Chart.js could not load';
      el.empty.querySelector('.hint').textContent =
        'The chart library is served from a CDN — check the browser console and your connection.';
      return;
    }

    const typing = sessions.filter((session) => session.type === 'typing');
    const reading = sessions.filter((session) => session.type === 'reading');

    // ---- Words per minute over time (typing + reading target pace) --------
    const wpmLabels = sessions.map((session, index) =>
      `${index + 1}. ${session.type === 'typing' ? '⌨️' : '📖'}`
    );

    drawChart('wpm', 'chart-wpm', {
      type: 'bar',
      data: {
        labels: wpmLabels,
        datasets: [
          {
            label: 'Session WPM',
            data: sessions.map((session) => Math.round(session.wpm)),
            backgroundColor: sessions.map((session) =>
              session.type === 'typing' ? '#A7F3D0' : '#FDE68A'
            ),
            borderColor: sessions.map((session) =>
              session.type === 'typing' ? '#34D399' : '#FBBF24'
            ),
            borderWidth: 2,
            borderRadius: 10,
            maxBarThickness: 46
          }
        ]
      },
      options: baseOptions('Session (⌨️ typing · 📖 reading)')
    });

    // ---- Typing accuracy progression -------------------------------------
    const accuracySessions = typing.filter((session) => typeof session.accuracy === 'number');
    const accuracyValues = accuracySessions.map((session) => session.accuracy);
    const accuracyFloor = accuracyValues.length
      ? Math.max(0, Math.min(...accuracyValues) - 5)
      : 0;
    drawChart('accuracy', 'chart-accuracy', {
      type: 'bar',
      data: {
        labels: accuracySessions.map((session, index) => `Typing ${index + 1}`),
        datasets: [
          {
            label: 'Accuracy %',
            data: accuracySessions.map((session) => session.accuracy),
            backgroundColor: barColors(accuracySessions.length, false),
            borderColor: barColors(accuracySessions.length, true),
            borderWidth: 2,
            borderRadius: 10,
            maxBarThickness: 46
          }
        ]
      },
      options: Object.assign(baseOptions('Typing session'), {
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#948ca6', font: { family: 'Quicksand', size: 11 } }
          },
          y: {
            beginAtZero: false,
            min: accuracyFloor,
            max: 100,
            grid: { color: 'rgba(124,110,166,.12)' },
            border: { display: false },
            ticks: { color: '#948ca6', font: { family: 'Quicksand', size: 11 } }
          }
        }
      })
    });

    // ---- Errors per typing session ---------------------------------------
    drawChart('errors', 'chart-errors', {
      type: 'bar',
      data: {
        labels: typing.map((session, index) => `Typing ${index + 1}`),
        datasets: [
          {
            label: 'Errors',
            data: typing.map((session) => session.errors || 0),
            backgroundColor: barColors(typing.length, false).map(() => '#FDA4AF'),
            borderColor: '#FB7185',
            borderWidth: 2,
            borderRadius: 10,
            maxBarThickness: 46
          }
        ]
      },
      options: baseOptions('Typing session')
    });
  }

  function renderStats(aggregates, total) {
    const reading = aggregates.reading || {};
    const typing = aggregates.typing || {};

    el.sessions.textContent = String(total == null ? aggregates.totalSessions || 0 : total);
    el.typingBest.textContent = typing.bestWpm == null ? '–' : String(typing.bestWpm);
    el.typingAvg.textContent = typing.avgWpm == null ? '–' : String(typing.avgWpm);
    el.accuracy.textContent = typing.avgAccuracy == null ? '–' : String(typing.avgAccuracy);
    el.readingAvg.textContent = reading.avgWpm == null ? '–' : String(reading.avgWpm);
    el.minutes.textContent = String(Math.round((aggregates.totalPracticeSec || 0) / 60));
  }

  async function load(force) {
    if (loading) return;
    if (!force && !dirty) return;

    loading = true;
    try {
      const data = await Pacer.api.getStats(CHART_WINDOW);
      const sessions = data.sessions || [];
      const total = typeof data.total === 'number' ? data.total : sessions.length;

      renderStats(data.aggregates || {}, total);
      dirty = false;

      if (el.backend) {
        const label = data.backend === 'sqlite' ? 'SQLite history' : 'JSON history';
        el.backend.textContent = `🗄 ${label}`;
        el.backend.title =
          data.backend === 'sqlite'
            ? 'Long-term history stored in a local SQLite database.'
            : 'History stored in stats.json (node:sqlite unavailable).';
      }

      if (el.note) {
        if (total === 0) {
          el.note.textContent = '';
        } else if (data.truncated) {
          el.note.textContent =
            `Charts show the most recent ${sessions.length} of ${total} sessions; ` +
            'the averages above cover your full history.';
        } else {
          el.note.textContent = `Charts show all ${total} recorded session${total === 1 ? '' : 's'}.`;
        }
      }

      if (total === 0) {
        el.charts.hidden = true;
        el.empty.hidden = false;
        el.empty.querySelector('strong').textContent = 'No sessions yet';
        el.empty.querySelector('.hint').textContent =
          'Finish a reading or typing run and the colourful charts will appear here.';
      } else {
        el.empty.hidden = true;
        el.charts.hidden = false;
        renderCharts(sessions);
      }
    } catch (error) {
      Pacer.ui.toast(`Could not load stats: ${error.message}`, 'error');
    } finally {
      loading = false;
    }
  }

  function invalidate() {
    dirty = true;
    if (Pacer.main && Pacer.main.activeTab === 'analytics') load(true);
  }

  async function clearHistory() {
    if (!window.confirm('Delete all saved reading and typing sessions? This cannot be undone.')) {
      return;
    }
    try {
      await Pacer.api.clearStats();
      Pacer.ui.toast('History cleared.', 'ok');
      await load(true);
    } catch (error) {
      Pacer.ui.toast(`Could not clear history: ${error.message}`, 'error');
    }
  }

  function bindControls() {
    if (el.refresh) el.refresh.addEventListener('click', () => load(true));
    if (el.clear) el.clear.addEventListener('click', clearHistory);
  }

  function init() {
    cacheElements();
    bindControls();
  }

  Pacer.analytics = { init, load, invalidate };
})();
