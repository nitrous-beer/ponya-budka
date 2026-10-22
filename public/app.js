// Клиентская логика Dashboard Поняшиной будки
let books = [];
let currentBook = null;
let currentSpreadIndex = 0;
let pages = [];
let bookmarks = [];
let selectedGenre = 'all';
let selectedDiceMode = '2d6';

const magicBallPhrases = [
  "Бесспорно!", "Звезды говорят: на тыгыдык", "Спроси у кота",
  "Маслину поймаешь", "Сладкий рулет твой", "Определенно мяу",
  "Стрела в колене мешает", "Чистый кайф", "Лучше почитай"
];

// Регистрация PWA Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

async function initApp() {
  await fetchBooks();
  setAppTheme('anime', document.querySelector('.theme-select-item.active'));
}

async function fetchBooks() {
  try {
    const res = await fetch('/api/books');
    if (res.ok) books = await res.json();
  } catch (e) {
    console.warn("Ошибка связи с сервером");
  }
  renderBooksList();
  if (books.length > 0) loadBook(books[0].id);
}

function renderBooksList() {
  const container = document.getElementById('booksListContainer');
  const searchVal = (document.getElementById('bookSearchInput')?.value || '').toLowerCase();
  container.innerHTML = "";

  const filtered = books.filter(b => {
    const matchesGenre = selectedGenre === 'all' || b.genre === selectedGenre;
    const matchesSearch = b.title.toLowerCase().includes(searchVal) || b.author.toLowerCase().includes(searchVal);
    return matchesGenre && matchesSearch;
  });

  document.getElementById('totalBooksCounter').innerText = `Всего книг: ${books.length}`;

  filtered.forEach(b => {
    const card = document.createElement('div');
    card.className = `book-item-card ${currentBook && currentBook.id === b.id ? 'active' : ''}`;
    card.onclick = () => loadBook(b.id);
    card.innerHTML = `
      <div class="book-cover-thumb"><i class="fa-solid fa-book"></i></div>
      <div class="book-info-col">
        <div class="book-info-title">${b.title}</div>
        <div class="book-info-author">${b.author}</div>
      </div>
      <button class="book-item-delete" title="Удалить книгу" onclick="deleteBookFromServer('${b.id}', event)">
        <i class="fa-solid fa-trash"></i>
      </button>
    `;
    container.appendChild(card);
  });
}

function loadBook(id) {
  const found = books.find(b => b.id === id);
  if (!found) return;
  currentBook = found;
  currentSpreadIndex = 0;

  document.getElementById('activeBookTitle').innerText = found.title;
  document.getElementById('activeBookAuthor').innerText = found.author;

  paginate(found.content);
  renderSpread();
  renderBooksList();
}

function paginate(text) {
  pages = [];
  const paras = (text || '').split('\n');
  let pageBuffer = "";
  paras.forEach(p => {
    const tr = p.trim();
    if (!tr) return;
    if (tr.startsWith('### ')) {
      if (pageBuffer) { pages.push(pageBuffer); pageBuffer = ""; }
      pageBuffer += `<h2>${tr.replace('### ', '')}</h2>`;
    } else {
      if ((pageBuffer.length + tr.length) > 520 && pageBuffer) {
        pages.push(pageBuffer);
        pageBuffer = `<p>${tr}</p>`;
      } else {
        pageBuffer += `<p>${tr}</p>`;
      }
    }
  });
  if (pageBuffer) pages.push(pageBuffer);
  if (pages.length === 0) pages.push("<p>Пусто</p>");
}

function renderSpread() {
  const leftIdx = currentSpreadIndex * 2;
  const rightIdx = leftIdx + 1;

  document.getElementById('leftPageText').innerHTML = pages[leftIdx] || "";
  document.getElementById('leftPageNum').innerText = leftIdx + 1;

  const rightEl = document.getElementById('rightPageText');
  if (rightIdx < pages.length) {
    rightEl.innerHTML = pages[rightIdx];
    document.getElementById('rightPageNum').innerText = rightIdx + 1;
  } else {
    rightEl.innerHTML = "<div style='text-align:center; margin-top:40%; opacity:0.3;'><i class='fa-solid fa-paw' style='font-size:2rem;'></i><br><br>Конец</div>";
    document.getElementById('rightPageNum').innerText = "";
  }

  const total = pages.length;
  const currentRead = Math.min(rightIdx + 1, total);
  document.getElementById('pageStatsLabel').innerText = `Страница ${currentRead} из ${total}`;

  const pct = Math.round((currentRead / total) * 100);
  document.getElementById('miniProgressFill').style.width = pct + "%";
  document.getElementById('readerProgressRange').value = pct;

  updateBookmarkUI();
}

function nextSpread() {
  if ((currentSpreadIndex + 1) * 2 < pages.length) {
    currentSpreadIndex++;
    renderSpread();
  }
}

function prevSpread() {
  if (currentSpreadIndex > 0) {
    currentSpreadIndex--;
    renderSpread();
  }
}

function seekBySlider(val) {
  const total = pages.length;
  const target = Math.floor((val / 100) * total);
  currentSpreadIndex = Math.floor(target / 2);
  renderSpread();
}

function setAppTheme(themeId, el) {
  document.body.setAttribute('data-theme', themeId);
  document.querySelectorAll('.theme-select-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  showToast(`Тема переключена: ${themeId}`);
}

function updateHeaderVisibility() {
  const showTitle = document.getElementById('toggleHeadTitle').checked;
  const showAuthor = document.getElementById('toggleHeadAuthor').checked;
  document.getElementById('headLeftTitle').style.visibility = showTitle ? 'visible' : 'hidden';
  document.getElementById('headRightAuthor').style.visibility = showAuthor ? 'visible' : 'hidden';
}

function switchFunTab(type) {
  document.getElementById('tabMagicBallBtn').classList.toggle('active', type === 'ball');
  document.getElementById('tabDiceBtn').classList.toggle('active', type === 'dice');
  document.getElementById('ballSection').style.display = type === 'ball' ? 'block' : 'none';
  document.getElementById('diceSection').style.display = type === 'dice' ? 'block' : 'none';
}

function selectDiceMode(mode) {
  selectedDiceMode = mode;
  document.getElementById('block2d6').classList.toggle('active', mode === '2d6');
  document.getElementById('blockD20').classList.toggle('active', mode === 'd20');
}

function executeRoll() {
  const resEl = document.getElementById('funResultLabel');
  if (selectedDiceMode === '2d6') {
    const v1 = Math.floor(Math.random() * 6) + 1;
    const v2 = Math.floor(Math.random() * 6) + 1;
    resEl.innerText = `🎲 Результат: ${v1 + v2} (${v1} + ${v2})`;
  } else {
    const v = Math.floor(Math.random() * 20) + 1;
    resEl.innerText = `🎲 Результат D20: ${v}`;
  }
}

function shakeBall() {
  const rand = magicBallPhrases[Math.floor(Math.random() * magicBallPhrases.length)];
  document.getElementById('magicBallAnswer').innerText = `«${rand}»`;
}

function toggleCurrentBookmark() {
  if (!currentBook) return;
  const pageNum = (currentSpreadIndex * 2) + 1;
  const idx = bookmarks.findIndex(b => b.bookId === currentBook.id && b.page === pageNum);
  if (idx !== -1) {
    bookmarks.splice(idx, 1);
    showToast("Закладка удалена");
  } else {
    bookmarks.push({ bookId: currentBook.id, page: pageNum });
    showToast(`Закладка сохранена на стр. ${pageNum}`);
  }
  updateBookmarkUI();
}

function updateBookmarkUI() {
  if (!currentBook) return;
  const pageNum = (currentSpreadIndex * 2) + 1;
  const hasMark = bookmarks.some(b => b.bookId === currentBook.id && (b.page === pageNum || b.page === pageNum + 1));
  const icon = document.getElementById('topBookmarkIcon');
  if (hasMark) {
    icon.className = "fa-solid fa-bookmark";
    icon.style.color = "#6366f1";
    document.getElementById('bookmarkSnippetText').innerText = `Закладка сохранена на странице ${pageNum}`;
  } else {
    icon.className = "fa-regular fa-bookmark";
    icon.style.color = "";
    document.getElementById('bookmarkSnippetText').innerText = `У вас пока нет закладок в этой книге`;
  }
}

function setFilterGenre(genre, el) {
  selectedGenre = genre;
  document.querySelectorAll('.tag-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderBooksList();
}

function filterBooks() { renderBooksList(); }

async function saveBookToServer() {
  const title = document.getElementById('editBookTitle').value.trim();
  const author = document.getElementById('editBookAuthor').value.trim();
  const genre = document.getElementById('editBookGenre').value;
  const content = document.getElementById('editBookContent').value.trim();

  if (!title || !content) return alert("Заполните название и текст!");

  const payload = {
    id: "book-" + Date.now(),
    title,
    author: author || "Аноним",
    genre,
    content
  };

  const authToken = localStorage.getItem('budka_admin_token');
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;

    const res = await fetch('/api/books', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const data = await res.json();
      books = data.books;
      closeModals();
      renderBooksList();
      loadBook(payload.id);
      showToast("Книга сохранена в базу SQLite!");
    } else {
      const err = await res.json();
      alert(err.error || "Ошибка сохранения (авторизуйтесь как администратор)");
    }
  } catch (e) {
    alert("Ошибка связи с сервером");
  }
}

async function deleteBookFromServer(bookId, e) {
  e.stopPropagation();
  if (!confirm("Удалить эту книгу навсегда из базы данных?")) return;

  const authToken = localStorage.getItem('budka_admin_token');
  try {
    const headers = {};
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;

    const res = await fetch(`/api/books/${bookId}`, {
      method: 'DELETE',
      headers: headers
    });
    if (res.ok) {
      const data = await res.json();
      books = data.books;
      renderBooksList();
      if (currentBook && currentBook.id === bookId) {
        if (books.length > 0) loadBook(books[0].id);
      }
      showToast("Книга удалена");
    } else {
      const err = await res.json();
      alert(err.error || "Ошибка удаления (требуются права администратора)");
    }
  } catch (err) {
    alert("Ошибка связи с сервером");
  }
}

async function loginSubmit() {
  const u = document.getElementById('authUsernameInput').value.trim();
  const p = document.getElementById('authPasswordInput').value.trim();
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      localStorage.setItem('budka_admin_token', data.token);
      document.getElementById('headerUserName').innerText = data.username;
      document.getElementById('currentUserBadge').innerText = data.username;
      closeModals();
      showToast(`Успешный вход в систему!`);
    } else {
      alert(data.error || 'Ошибка входа');
    }
  } catch (err) {
    alert('Ошибка связи с сервером');
  }
}

function openEditorModal() {
  document.getElementById('editBookTitle').value = "";
  document.getElementById('editBookAuthor').value = "";
  document.getElementById('editBookContent').value = "";
  openModal('editorModal');
}
function openAuthModal() { openModal('authModal'); }
function openAdminModal() { openModal('adminModal'); }
function openModal(id) {
  closeModals();
  document.getElementById(id)?.classList.add('open');
}
function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
}
function showToast(msg) {
  const t = document.getElementById('toastMsg');
  t.innerText = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}
function toggleFullScreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}

window.addEventListener('DOMContentLoaded', initApp);
