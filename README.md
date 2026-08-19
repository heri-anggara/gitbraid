# GitBraid

Git GUI client untuk Linux. Electron di depan, `git` CLI asli di belakang.

Riwayat commit ditampilkan sebagai lane berwarna seperti GitKraken, lengkap dengan
staging per-hunk, diff viewer, dan operasi branch/remote/stash lewat menu konteks.

---

## Jalankan

Butuh Node.js 18+ dan `git` yang sudah ada di `PATH`.

```bash
cd gitbraid
npm install
npm start
```

Kalau Electron gagal jalan di Ubuntu dengan error sandbox:

```bash
sudo sysctl -w kernel.unprivileged_userns_clone=1
# atau, sekali jalan saja:
npm start -- --no-sandbox
```

## Platform

GitBraid ditulis lintas platform, tapi sejauh ini **hanya diuji di Linux**.
Itu pernyataan yang jujur, bukan basa-basi: saya belum pernah menjalankannya di
macOS maupun Windows.

| | Keadaan |
|---|---|
| **Linux** | Diuji penuh. AppImage dan `.deb` |
| **macOS** | Kode sudah benar per platform, konfigurasi `dmg`/`zip` siap. Build **harus** di mesin macOS |
| **Windows** | Kode sudah benar per platform, konfigurasi `nsis`/`portable` siap. Belum dijalankan di sana |

Yang membuatnya tidak lagi terikat Linux:

- Perintah terminal sistem punya tabel sendiri tiap platform (`open -a Terminal`
  di macOS, `wt.exe` → PowerShell → `cmd` di Windows). Entri yang mengandalkan
  `cwd` alih-alih argumen **wajib menyatakannya** lewat `usesCwd: true`, dan
  ada uji yang menolak entri yang diam saja
- `/dev/null` jadi `NUL` di Windows
- Panel terminal memakai `ComSpec` di Windows, `$SHELL` di tempat lain
- **Reword tidak lagi memerlukan `sed` dan `cp`.** git memanggil editornya lewat
  shell, dan alat itu tidak ada di Windows. Sekarang GitBraid menuliskan skrip
  Node kecil lalu menjalankannya dengan binernya sendiri
  (`ELECTRON_RUN_AS_NODE`) — satu-satunya penafsir yang pasti ada di tiap
  pemasangan
- `which()` menghormati `PATHEXT` di Windows (`code.cmd`, `wt.exe`), dan daftar
  editornya berbeda tiap platform
- Helper path menerima `\` maupun `/`, karena path repo di Windows berupa
  `C:\Users\…` sementara path *di dalam* repo selalu dilaporkan git dengan `/`
- macOS mendapat menu aplikasi sendiri (About, Preferences, Hide, Quit)

Logika per platform yang tidak bisa dijalankan di sini diuji sebagai fungsi
murni dengan `process.platform` dipatok — 11 uji, jalan di `npm test`.

**Untuk distribusi nyata:** `.exe` tanpa tanda tangan memicu peringatan
SmartScreen, dan aplikasi macOS tanpa notarisasi diblokir Gatekeeper. Keduanya
butuh sertifikat berbayar.

## Build

```bash
npm run dist        # Linux: AppImage + deb
npm run dist:win    # Windows: nsis + portable — bisa dari Linux, perlu wine
npm run dist:mac    # macOS: dmg + zip — WAJIB dijalankan di mesin macOS
# hasilnya ada di dist/
```

## Kenapa aplikasinya tidak terlihat sistem

Menjalankan dari sumber (`npm start`) **bukan** memasang. Selama belum ada paket
yang terpasang, sistem tidak tahu apa pun tentang GitBraid: tidak muncul di
daftar aplikasi, tidak di GNOME Software, dan jendelanya masuk ke "System
Processes" alih-alih dikenali sebagai aplikasi.

Setelah paketnya dipasang pun ada satu syarat lagi yang mudah terlewat: GNOME
Software menyusun daftar "Installed" dari **AppStream**, bukan dari berkas
`.desktop`. Paket tanpa `metainfo.xml` terpasang akan berjalan dengan normal,
punya ikon dan entri menu, tapi tetap tidak tercantum di toko perangkat lunak.

**Peringatan untuk siapa pun yang menyentuh `after-install.sh`:** berkas itu
**menggantikan** postinst bawaan electron-builder, bukan menambahinya. Semua
langkah bawaan harus tetap ada di sana — terutama
`chmod 4755 /opt/GitBraid/chrome-sandbox`. Tanpa baris itu Electron menolak
berjalan sama sekali:

```
FATAL:setuid_sandbox_host.cc(158) The SUID sandbox helper binary was found,
but is not configured correctly.
```

Gejalanya menyesatkan: dari terminal aplikasinya bisa jalan, tapi dari menu atau
dock langsung mati. Sebabnya profil AppArmor berbeda — proses yang dijalankan
dari sesi yang sudah ter-confine (misalnya terminal VS Code) mendapat izin
`userns_create` sehingga Electron memakai sandbox namespace dan tidak butuh
helper SUID, sedangkan gnome-shell menjalankannya sebagai `unconfined`, yang di
Ubuntu ditolak, lalu jatuh ke helper SUID yang izinnya salah.

Langkah bawaan yang wajib ditiru ada di
`node_modules/app-builder-lib/templates/linux/after-install.tpl`: symlink
`/usr/bin` lewat `update-alternatives`, `chmod 4755` untuk chrome-sandbox,
`update-mime-database`, dan `update-desktop-database`.

`electron-builder` tidak bisa menaruh berkas di luar `/opt` lewat konfigurasinya
— `extraFiles` dengan `to: "../usr/..."` diam-diam tidak menghasilkan apa-apa,
sudah diperiksa dengan `dpkg -c`. Jadi metainfo ikut di dalam aplikasi lewat
`extraResources`, lalu skrip `after-install.sh` menyalinnya ke
`/usr/share/metainfo/` dan menyegarkan cache; `after-remove.sh` menghapusnya
lagi saat paket dicopot.

Memasang hasil build:

```bash
sudo dpkg -i dist/gitbraid_0.1.0_amd64.deb
```

## Merilis ke pengguna lain

Berkas untuk toko aplikasi ada di [`build/linux/`](build/linux/), masih berupa
templat karena dua nilai harus datang dari Anda: **username GitHub** dan
**email kontak**. Isi sekali dengan:

```bash
./build/linux/fill.sh <username-github> <email> [url-donasi]
```

Skrip itu menghasilkan `io.github.<user>.GitBraid.metainfo.xml` dan
`.desktop`, menghapus templatnya, lalu menyebutkan App ID yang harus disalin ke
`build.appId` di `package.json`. Tanda hubung pada username diganti garis bawah
di App ID saja — AppStream melarangnya, URL tetap memakai username asli.

Keduanya sudah divalidasi di sini dengan `appstreamcli validate` dan
`desktop-file-validate`, dengan dan tanpa tautan donasi. Satu catatan pedantic
tersisa (`cid-contains-uppercase-letter` untuk `GitBraid`) dan itu memang
konvensi yang dianjurkan Flathub, bukan kesalahan.

**Yang masih kurang sebelum mendaftar:** tangkapan layar di `screenshots/`.
Nama berkas yang ditunggu `metainfo.xml` ada di
[`screenshots/README.md`](screenshots/README.md). Flathub menolak listing tanpa
tangkapan layar.

Satu peringatan yang perlu dibaca sebelum mengambilnya: halaman toko itu publik
dan permanen. Tangkapan layar dari repo kerja akan ikut memuat nama repositori,
pesan commit, nama cabang, dan isi berkas yang terbuka di layar. Pakai
repositori yang memang boleh dilihat siapa saja.

### Soal informasi pribadi

| | Publik? |
|---|---|
| Nama pengembang, email kontak, lisensi | ya — email boleh alias atau `noreply` GitHub |
| App ID | harus milik Anda: `io.github.<user>.…` cukup, tanpa perlu domain |
| Nama asli, alamat, rekening | **tidak** — hanya ke penyedia pembayaran saat menerima donasi |

Lencana **verified** di Flathub membuktikan Anda pemilik repo sumbernya, lewat
login GitHub atau bukti kepemilikan domain. Itu verifikasi kepemilikan, bukan
verifikasi identitas.

Perlu diingat: email yang dipakai untuk commit ikut masuk ke riwayat git dan
bersifat permanen setelah dipublikasikan. Setel per repo sebelum commit
pertama, jangan mengandalkan setelan global:

```bash
git config --local user.email "email-yang-Anda-pilih"
```

## Test

```bash
npm test
```

55 test yang mengecek parser status, parser log, algoritma lane pada graph,
titik akhir setiap garis, parser diff, dan — yang paling penting — apakah patch
per-hunk hasil rekonstruksi benar-benar diterima oleh `git apply`.

---

## Yang sudah jalan

**Menu bar**
- **File** — Open / Clone / Init Repo, `Open Recent` (terisi otomatis, plus
  Clear Recent), Open in File Manager, Open External Terminal, Close
  Repository, Quit
- **Edit** — Undo, Redo, Cut, Copy, Paste, Select All
- **View** — Relaunch, Toggle Full Screen, zoom in/out/reset, `Show Left Panel`
  (`Ctrl+J`) dan `Show Commit Details Panel` (`Ctrl+K`) berupa checkbox, Refresh,
  Toggle Developer Tools
- **Help** — Keyboard Shortcuts (`Ctrl+/`), View Release Notes, About GitBraid
- Item yang butuh repo otomatis abu-abu selama belum ada repo terbuka, dan
  checkbox panel selalu mengikuti keadaan jendela

**Saat dibuka**
- Kalau sudah pernah membuka repo, GitBraid langsung masuk ke repo yang
  terakhir dipakai — tidak mampir ke halaman awal lagi
- Halaman awal hanya muncul kalau memang belum ada riwayat sama sekali, atau
  kalau repo terakhir sudah tidak bisa dibuka (alasannya tampil di status bar)
- Mau kembali ke halaman awal kapan saja: `Ctrl+T` atau tombol `+`

**Layar awal**
- Tiga aksi yang jelas: buka repo lokal, clone dari URL, atau `git init` repo baru
- Dialog clone satu langkah: URL, folder tujuan (tombol **Browse…**), dan nama
  folder yang terisi otomatis dari URL, plus baris pratinjau `Creates ~/…`
- Progress bar clone yang bergerak mengikuti output `git clone --progress`
- Daftar repo terakhir menampilkan nama, path yang dipendekkan ke `~`, dan kapan
  terakhir dibuka; tiap baris bisa dihapus satu-satu atau dibersihkan semua
- Drag folder repo ke jendela untuk langsung membukanya
- Toolbar tidak menampilkan tombol Fetch/Pull/Push sebelum ada repo yang terbuka;
  chip nama repo di kiri sekaligus jadi pemindah repo (buka lain, clone, salin
  path, buka di file manager, tutup repo)

**Tab repositori**
- Beberapa repo terbuka sekaligus dalam tab; membuka repo yang sudah ada
  hanya memindah fokus ke tab-nya, tidak membuat tab kedua
- Tombol `+` (atau `Ctrl+T`) membuka **New Tab** berisi halaman depan —
  Open / Clone / Create beserta daftar repo terakhir. Begitu Anda memilih
  repo dari situ, tab itu sendiri yang terisi, bukan bikin tab baru lagi
- Tiap tab menyimpan sendiri riwayat, pilihan commit, posisi scroll, dan isi
  kotak pesan commit — pindah tab tidak mengoper draf ke repo lain
- Toolbar, sidebar, dan judul jendela selalu mengikuti tab yang aktif,
  termasuk badge ahead/behind pada Pull dan Push
- `Ctrl+W` tutup tab, `Ctrl+Tab` / `Ctrl+Shift+Tab` pindah tab, klik tengah
  untuk menutup, klik kanan untuk menu tab
- Tombol `⌄` di kanan tab: **Search Tabs** — ketik untuk menyaring tab yang
  terbuka, Enter membuka hasil teratas
- **Semua tab kembali saat aplikasi dijalankan lagi**, pada tab yang terakhir
  Anda lihat. Daftarnya disimpan setiap kali berubah, bukan saat keluar, jadi
  aplikasi yang mati mendadak pun tidak menghilangkan susunan tab Anda
- Hanya tab yang aktif yang memuat riwayatnya; tab lain baru memuat saat
  diklik — itu yang membuat sepuluh repo terbuka tetap murah di RAM
- Repo yang foldernya sudah dihapus di luar aplikasi tidak dipulihkan sebagai
  tab rusak, tapi dilewati. Tab aktif disimpan sebagai path, bukan nomor urut,
  supaya tidak meleset ke tab lain kalau ada repo di depannya yang hilang
- Bisa dimatikan lewat Preferences → General → *Reopen last session's tabs*

**Panel nama repo (sidebar)**
- Panah di sebelah nama repo membuka aksi untuk **repo yang sedang dibuka**,
  bukan pemindah repo: salin path, salin URL remote, buka di file manager /
  terminal / code editor, tandai favorit, tutup tab, dan satu jalan ke
  Repository management.
- Membuka repo lain, clone, dan daftar repo terakhir sengaja **tidak** ada di
  sini — ketiganya sudah punya rumah di halaman New Tab dan di Repository
  management, dan pintu keempat hanya memanjangkan menu tanpa membuat apa pun
  jadi lebih mudah dijangkau.
- Entri yang tidak bisa dijalankan tetap terlihat dan menjelaskan alasannya
  saat di-hover — repo tanpa remote menampilkan "Copy remote URL" dalam
  keadaan mati, bukan menghilangkannya.
- **Open in terminal** membuka emulator terminal sistem tepat di folder repo.
  Direktorinya dikirim sebagai argumen resmi tiap emulator
  (`--working-directory=`, `--workdir`, `--directory`, `start --cwd`), bukan
  sekadar `cwd` pada proses: keluarga GNOME (ptyxis, gnome-terminal)
  `DBusActivatable`, jadi proses yang kita jalankan hanya menitip pesan ke
  instance yang sudah hidup, dan instance itulah yang menentukan direktori
  jendelanya. `x-terminal-emulator` ditelusuri dulu ke program aslinya supaya
  argumen yang benar yang dipakai.
- Satu catatan jujur untuk Ptyxis: kalau Ptyxis **belum berjalan sama sekali**,
  ia membuka satu jendela bawaannya sendiri lebih dulu, baru jendela yang
  diminta — jadi sesaat ada dua jendela. Itu perilaku aktivasi Ptyxis, bukan
  sesuatu yang bisa dimatikan dari baris perintah (`--tab` pun sama). Begitu
  Ptyxis sudah berjalan, hasilnya tepat satu jendela di folder repo.
- Emulator yang menolak argumennya akan langsung keluar; GitBraid menunggu
  sebentar untuk memastikan sebelum menyatakan berhasil, lalu mencoba emulator
  berikutnya. Jadi daftar cadangannya benar-benar berfungsi, bukan berhenti di
  program pertama yang kebetulan terpasang.

**Cari commit**
- `Ctrl+F` membuka baris pencarian di atas riwayat; mencari di judul, isi
  pesan, nama penulis, email, dan SHA
- Yang cocok disorot dan yang tidak cocok diredupkan (bukan disembunyikan,
  supaya garis graph di sebelahnya tidak putus)
- Penghitung `3 of 12`, `Enter` / `Shift+Enter` atau tombol ↑ ↓ untuk lompat
  antar hasil, `Esc` menutup

**Repository management**
- Tombol folder di ujung kiri strip tab, atau `Ctrl+Shift+O`, membuka halaman
  penuh berisi empat kelompok: **Open repositories**, **Favorites**,
  **Recent repositories**, dan **All repositories** — tiap kelompok punya
  penghitung dan bisa dilipat (Collapse / Expand semuanya)
- Tiap baris menampilkan nama, owner (dibaca dari URL remote), dan cabang aktif
- Lebar kolom cabang dan kolom status kerja **dikunci**, bukan mengikuti isi
  baris masing-masing. Tiap baris adalah grid tersendiri, jadi kolom yang
  menyesuaikan isinya akan mendarat di tempat berbeda pada tiap baris: baris
  bertulis `clean` dan baris bertulis `45 modified 121 added 21 deleted` dulu
  memulai chip cabangnya terpaut 90px. 228px itu lebar terukur dari kasus
  terburuk tersebut, jadi tidak ada yang terpotong
- Nama cabang yang panjang dipotong dengan elipsis dalam satu baris — dulu ia
  membungkus di dalam pill-nya sendiri sehingga baris itu lebih tinggi dari
  yang lain. Nama lengkapnya muncul saat di-hover
- **Scan a folder…** menyisir folder sampai tiga tingkat dan mengingat repo yang
  ditemukan; `node_modules`, `vendor`, `dist`, dan sejenisnya dilewati, dan
  begitu satu folder terbukti repo, isinya tidak ditelusuri lagi
- Kolom cabang dan owner dibaca **langsung dari `.git/HEAD` dan `.git/config`**,
  tanpa memanggil git — jadi daftar berisi puluhan repo tetap tampil seketika
- **WIP summary** (kotak centang) menampilkan jumlah berkas belum di-commit per
  repo. Ini yang memang memanggil git per repo, jadi sifatnya opsional
- Bintang untuk favorit, `⋯` untuk buka di editor / file manager / terminal,
  salin path, atau lupakan repo dari daftar (berkas di disk tidak disentuh)

**Panel perubahan belum di-commit**
- Judul dan deskripsi commit dipisah, sesuai kebiasaan pesan git; `Ctrl+Enter`
  dari kolom mana pun langsung commit
- Penghitung panjang judul muncul setelah 40 karakter, berubah amber di atas 50
  dan merah di atas 72 — batas yang membuat `git log --oneline` memotong judul
- Tombol Commit menyebut jumlahnya (`Commit 3 files`) dan menjelaskan sendiri
  kenapa ia nonaktif
- Stage all / Unstage all / Discard all jadi tombol ikon, bukan tautan teks
  berdempetan; aksi per-berkas juga ikon dan muncul saat baris di-hover
- Nama berkas ditulis dua bobot: folder diredupkan, nama berkas tegas
- `git status` dijalankan dengan `--untracked-files=all`, jadi folder yang
  seluruhnya baru tetap terdaftar per berkas dan bisa di-stage satu per satu

**Penampil berkas di tengah**
- Toolbar-nya berupa ikon, penjelasannya lewat tooltip
- **Navigasi antar blok perubahan**: pertama / sebelumnya / berikutnya /
  terakhir, dengan penghitung `2/3`. Satu "blok" adalah satu rentetan baris yang
  tersentuh, jadi `3` berarti tiga suntingan, bukan tiga baris. Pintasan:
  `Alt+↑` `Alt+↓` `Alt+Home` `Alt+End`
- Panel detail commit bisa **dilipat ke samping** lewat panah di kepalanya,
  menyisakan bilah 26px yang seluruhnya jadi tombol untuk membukanya kembali.
  Berbeda dari View ▸ Show Commit Details Panel yang menyembunyikannya sama
  sekali; keduanya diingat setelah aplikasi ditutup
- Kolom **Graph** bisa disembunyikan dan ditarik lebarnya seperti kolom lain.
  Kalau ditarik lebih sempit dari yang dibutuhkan lane, gambarnya terpotong di
  tepi kolom, bukan meluber ke kolom pesan. *Reset columns* mengembalikannya ke
  lebar otomatis yang mengikuti jumlah lane
- **Peta perubahan** di tepi kanan, sejajar dengan scrollbar dan bukan
  menumpanginya: satu penanda per blok, hijau untuk tambahan, merah untuk
  hapusan, dan dua warna kalau blok itu melakukan keduanya. Tinggi penandanya
  sebanding dengan besar bloknya, dan blok yang sedang Anda lihat diberi bingkai
- Mengklik penanda melompat ke blok itu dan menggerakkan penghitung `2/12`
  bersamanya — jadi penanda ketujuh dari atas benar-benar perbedaan ketujuh,
  sama dengan yang dilompati `Alt+↓`. Mengklik jalur kosongnya menggulir ke
  posisi itu, seperti trough sebuah scrollbar
- Header berkas di dalam badan diff hanya muncul kalau yang ditampilkan memang
  lebih dari satu berkas, misalnya pada tampilan perbandingan. Untuk satu berkas
  ia mengulang nama dan hitungan yang sudah ada di header atas, persis sama
- **Show all lines** menampilkan seluruh berkas, bukan hanya potongan hunk
  (di balik layar: `-U100000`)
- **Syntax highlighting** untuk TS/JS/JSX/TSX, JSON, CSS, HTML, Markdown, SQL,
  shell, Python, YAML, Go, Rust — ditulis sendiri di [`src/highlight.js`](src/highlight.js),
  jadi GitBraid tetap tanpa dependensi runtime. Sifatnya per-baris, karena diff
  memang menampilkan potongan; berkas yang tak dikenal tampil tanpa warna dan
  tombolnya nonaktif
- **Ignore space** memakai `-w`: hanya baris yang perubahannya *murni* spasi yang
  disembunyikan. Baris yang indentasinya berubah **dan** isinya berubah tetap
  tampil — itu perilaku git, bukan kelalaian

**Membuka berkas di editor**
- Tombol `Open` di penampil berkas dan `Open in editor` di klik-kanan mencari
  editor kode yang terpasang, bukan menyerahkan berkas ke handler desktop —
  handler untuk `.tsx`/`.json` sering berupa browser, yang malah mengunduhnya
- Urutan pencarian: VS Code / VSCodium / Cursor / Zed / Sublime / JetBrains /
  Geany / gVim, lalu editor teks biasa (GNOME Text Editor, gedit, Kate, Xed,
  Mousepad, Pluma), dan baru terakhir handler bawaan sistem
- Mau menentukan sendiri? `git config gitbraid.editor "code -w"` — pilihan ini
  selalu diutamakan
- Status bar menyebut editor mana yang membuka berkasnya

**Klik di panel kiri**
- **Sekali klik** pada cabang, tag, atau cabang remote hanya memindahkan riwayat
  ke ujung ref itu — melihat-lihat tidak mengubah keadaan repo. Kalau commit-nya
  belum termuat, jendela riwayat melebar sendiri sampai ketemu
- **Klik ganda** yang melakukan checkout. Kalau ada berkas terlacak yang belum
  di-commit, GitBraid bertanya dulu: sisihkan ke stash lalu pasang kembali, bawa
  serta, atau buang. Berkas yang tidak dilacak git tidak dihitung dan tidak
  disentuh — checkout memang tak pernah menghapusnya
- Tag beranotasi menunjuk ke commit yang ditandainya, bukan ke objek tag-nya,
  jadi mengkliknya mendarat di baris yang benar dan urutan tanggalnya masuk akal
- Teks di bagian chrome — sidebar, toolbar, tab, daftar commit, status bar —
  tidak bisa diseleksi; ini aplikasi desktop, bukan halaman web. Yang tetap bisa
  diseleksi dan disalin adalah isinya: diff, keluaran terminal, pesan commit,
  log perintah, dan catatan rilis

**Merge**
- Merge tidak langsung jalan. Dialognya menyebutkan **arah**-nya — `Merge A into
  B` — berapa commit yang akan masuk, berapa yang sudah ada di B sendiri, dan
  apakah fast-forward mungkin. Salah arah adalah kesalahan merge yang paling
  sering terjadi, dan tidak ada label tombol yang bisa memperlihatkannya
- Tiga pilihan: **fast-forward bila memungkinkan** (bawaan, perilaku git
  sendiri), **selalu buat merge commit** (`--no-ff`, yang dipakai git-flow), dan
  **squash jadi satu perubahan** — yang membawa isinya masuk ke staging tanpa
  satu pun commit cabang asalnya, untuk Anda tulis pesannya sendiri
- Kalau cabangnya memang sudah termuat, tidak ada dialog sama sekali: statusnya
  cuma bilang tidak ada yang perlu di-merge
- Kalau ada perubahan yang belum di-commit, dialognya memberi tahu — git menolak
  merge kalau berkas itu ikut terlibat

**Klik kanan di panel kiri**
- **Cabang lokal** — checkout, fast-forward ke upstream, fetch upstream ke
  cabang itu, push, merge, rebase, bandingkan dengan HEAD, buat cabang/tag dari
  sini, atur tracking branch, ubah deskripsi, ganti nama, hapus, salin nama
- **Cabang remote** — checkout jadi cabang lokal, merge, rebase, bandingkan,
  buat cabang/tag, hapus di remote, salin nama
- **Tag** — checkout, bandingkan, buat cabang dari tag, hapus, salin nama
- Item yang tidak bisa dijalankan **tetap ditampilkan** dalam keadaan abu-abu,
  dan alasannya muncul saat di-hover — misalnya *"Already up to date with its
  upstream"* atau *"You cannot delete the branch you are on"*

**Git-Flow**
- Tombol `Git-Flow` di tengah toolbar. Kalau repo belum disiapkan, tombolnya
  membuka dialog **Initialize Git-Flow**: cabang produksi, cabang development,
  serta awalan feature / release / hotfix / tag versi
- Pengaturannya ditulis ke kunci `gitflow.*` di config repo — **kunci yang sama
  dengan yang dipakai git-flow versi baris perintah**, jadi repo yang disiapkan
  di sini tetap bisa dipakai dari terminal, dan sebaliknya
- Tidak memanggil biner `git flow` (sering belum terpasang); semuanya dijalankan
  dengan perintah git biasa
- Setelah siap, tombolnya membuka menu: mulai feature / release / hotfix. Kalau
  Anda sedang berada di salah satu cabang itu, labelnya berubah jadi
  `Finish feature` dan menunya menyediakan penyelesaiannya
- Menyelesaikan **feature**: merge ke development lalu cabangnya dihapus.
  **Release / hotfix**: merge ke produksi, diberi tag, merge ke development,
  lalu dihapus. Semua merge memakai `--no-ff` seperti git-flow asli
- Kalau cabangnya sudah pernah di-push, dialog penyelesaiannya menawarkan dua
  centang: **push** hasil merge (dan tag-nya) ke remote, dan **hapus cabang di
  remote**. Keduanya tercentang secara bawaan — setelah merge, seluruh commit
  cabang itu sudah ada di development, jadi ref di server tidak menyimpan apa
  pun yang unik lagi. Tanpa ini Anda berakhir di keadaan setengah mendarat:
  development lokal maju sendirian, cabang feature masih menggantung di server,
  dan tag rilis cuma ada di satu komputer
- Push dijalankan **sebelum** apa pun dihapus dari server. Kalau push ditolak —
  misalnya orang lain menggeser development lebih dulu — penghapusannya tidak
  jadi berjalan, jadi cabang itu tetap ada di remote sebagai satu-satunya salinan
  pekerjaan tersebut di sana
- Kalau ada langkah yang gagal (misalnya konflik), pesannya menyebut langkah
  mana yang berhenti dan repo dibiarkan apa adanya untuk Anda selesaikan.
  Alasannya diambil dari baris yang benar-benar menjelaskan — sebuah push yang
  ditolak dibuka dengan `To <url>`, yang tidak memberi tahu apa-apa

**Panel kiri**
- Nama repo dan branch yang sedang di-checkout ada di paling atas panel; nama
  repo sekaligus jadi tombol pindah repo, dan judul jendela ikut nama repo
- Branch, remote, dan tag ditampilkan sebagai **tree**: `feature/kiosk-member`
  masuk ke folder `feature`, `origin/develop` masuk ke folder `origin`. Folder
  dan branch berbaris satu urutan alfabet, dan folder yang Anda tutup diingat
- Branch aktif ditandai centang, tebal, dan garis aksen di kiri
- Tags dan Stashes **tertutup secara default** (repo bisa punya ratusan tag);
  begitu Anda mengubahnya, pilihan Anda yang dipakai seterusnya

**About & release notes**
- **About GitBraid** kini digambar di dalam aplikasi, bukan kotak dialog sistem:
  memuat logo, versi, serta versi git / Electron / Chromium / Node / platform,
  plus tombol menyalin semua informasi itu untuk dilampirkan ke laporan bug
- Versinya dibaca dari `package.json` sendiri, bukan `app.getVersion()` — panggilan
  itu jatuh ke versi Electron kalau aplikasi tidak dijalankan sebagai paket
- **View Release Notes** membuka halaman penuh yang dibangun dari
  [`src/releases.js`](src/releases.js): satu entri per versi, dikelompokkan per
  area, plus bagian **Known limitations** yang jujur menyebut apa yang belum ada
- Entri bertanda `in development` adalah build yang sedang Anda pegang. Saat
  versinya di-tag, beri tanggal dan hapus penandanya, lalu mulai entri baru di atas

**Kolom riwayat**
- **Geser pembatas di header** untuk melebarkan atau mempersempit kolom; tiap
  kolom punya batas minimum sendiri dan lebarnya diingat antar sesi
- **Klik kanan header** untuk memilih kolom yang tampil: Branch / Tag, Author,
  Author Time, Commit Date / Time, SHA — plus **Reset column widths**
- Kolom **Author Time** (waktu penulisan, beda dari waktu commit) tersedia dan
  mati secara bawaan, seperti di klien lain
- Header dan setiap baris memakai **satu daftar track yang sama**
  (`--hist-cols`), jadi kolom yang digeser atau disembunyikan tidak mungkin
  membuat keduanya bergeser sendiri-sendiri
- Lebar minimum riwayat sebelum ia menggulir menyamping dihitung ulang dari
  kolom yang benar-benar tampil, bukan dari angka tetap

**Kolom Branch / Tag**
- `origin/HEAD` tidak lagi digambar sebagai badge. Itu penunjuk ke cabang default
  remote, bukan cabang tersendiri — sebelumnya ia jatuh ke keranjang "cabang
  lokal" dan muncul sebagai badge bermonitor
- Baris yang di-hover menampilkan **badge hantu** (bergaris putus-putus, redup)
  berisi nama cabang yang memuat commit itu — hanya pada baris yang belum punya
  badge sungguhan, jadi tidak menambah keramaian
- Keanggotaan cabang dihitung di sisi renderer dengan menyusuri tautan parent
  dari tiap ujung cabang, bukan dengan `git branch --contains` per baris yang
  berarti satu proses git setiap kali kursor bergerak
- Hover juga menampilkan **pesan commit utuh** (judul dan isi) di tooltip, karena
  kolomnya memotong teks panjang

**Riwayat**
- Commit graph multi-lane dengan deteksi merge dan pewarnaan per lane
- Garis bertekuk siku membulat, dot berisi avatar Gravatar penulis
- Kolom **Branch / Tag** tersendiri di kiri: pill per branch lokal, bertanda
  centang kalau sedang di-checkout, ikon monitor untuk lokal, ikon awan kalau
  branch yang sama juga ada di remote, dan ikon label untuk tag
- Baris commit diberi latar tipis mengikuti warna lane-nya
- Baris "Uncommitted changes" ikut masuk ke graph sebagai node putus-putus
- Tanggal absolut `08/14/2026 @ 2:59 PM`, plus cuplikan body commit yang diredupkan
- Muat 400 commit sekaligus, ada tombol untuk menambah
- Memilih baris hanya memindahkan sorotannya, tidak menggambar ulang daftarnya.
  Dulu satu klik menelan biaya sebesar membuka repo: pada 4.800 baris, 239 ms —
  177 ms di antaranya membangun ulang daftar yang satu-satunya perubahan adalah
  sebuah kelas CSS. Sekarang di bawah 1 ms berapa pun panjang daftarnya
- **Hanya baris yang terlihat yang dibuat.** Sebelumnya setiap commit yang dimuat
  jadi node DOM sungguhan: pada riwayat 8.951 commit itu 124.490 node di daftar
  plus 27.170 node SVG di graph, dan compositor membayarnya setiap kali digulir —
  frame median 67,9 ms, alias 15 fps. Sekarang yang ada di dokumen hanya sekitar
  satu layar penuh (± 600 node), dengan margin di atas dan bawah supaya menggulir
  biasanya tidak menggambar ulang sama sekali: frame median **7 ms, sama rata
  dari 400 sampai 8.951 baris**, dan `refresh()` pada riwayat penuh turun dari
  3.346 ms ke 235 ms
- Graph tetap digambar utuh: sebuah garis yang melintasi layar dari commit jauh
  di atas ke induknya jauh di bawah ikut digambar walau kedua ujungnya tak
  terlihat. Diperiksa terhadap perhitungan acuan di 65 pita berbeda yang semuanya
  mengandung merge — nol selisih
- Batas 400 baris itu bukan soal git: membaca seluruh 8.951 commit hanya 40 ms,
  praktis sama dengan membaca 400 (35 ms). Yang dulu mahal adalah menggambarnya
- Pindah tab memakai data yang sudah dipegang tab itu dulu, baru menyusul
  bertanya ke git di belakang layar. Tab berisi 9.000 commit: dari 3.346 ms
  menjadi ±90 ms; tab repo kecil ±20 ms

**Logo**
- Sumbernya satu file, [`build/icon.svg`](build/icon.svg): empat keping bergradasi
  tersusun jadi belah ketupat, dengan alur graph **dipotong dari kepingnya**
- Simpul alurnya duduk tepat di pusat tiap keping — setelah kelompok keping
  diputar 45°, keempat pusat itu jatuh di (60·28,9), (91,1·60), (28,9·60),
  (60·91,1), jadi jalur tegak dan cabang mendatar menembusnya persis
- Karena alurnya berupa lubang, warnanya selalu mengikuti latar di belakangnya:
  satu berkas untuk tema gelap dan terang, tanpa versi kedua
- PNG untuk jendela dan paket ada di `build/icons/` (16 sampai 512 px);
  regenerasi cukup render ulang `build/icon.svg`

**Tampilan**
- Tema gelap dan terang, ditukar lewat tombol di toolbar, pilihannya diingat
- Zoom seluruh jendela dengan `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, ikut diingat —
  berguna kalau 13px terasa kecil di monitor besar
- Layar awal ikut menyesuaikan lebar jendela, tidak terkunci di satu ukuran

**Perubahan**
- Daftar berkas punya **tiga tampilan**, dipilih lewat satu tombol ikon yang
  membuka menu. Pilihannya satu dan dipakai bersama oleh panel *Uncommitted
  changes* dan panel detail commit — bentuk yang sama berarti hal yang sama di
  kedua tempat, jadi menyimpan dua jawaban hanya membuatnya berselisih:
  - **Show as Path List** — satu baris per berkas dengan path lengkapnya
  - **Show as File and Dir List** — *nama berkasnya* yang dibaca duluan, foldernya
    mengiringi dengan warna redup. Perlu diingat: dua berkas bernama sama di
    folder berbeda — misal `route.ts` di `api/orders/[id]` dan di
    `api/products/[id]` — akan terlihat mirip di mode ini; Tree yang membedakannya
  - **Show as Filesystem Tree** mengelompokkan berkas ke dalam foldernya. Rantai folder yang tiap
    tingkatnya hanya berisi satu folder lagi **dipadatkan jadi satu baris**,
    seperti di editor: `src ▸ app ▸ api ▸ orders ▸ [id] ▸ route.ts` yang tadinya
    lima tingkat jadi `src ▸ app/api ▸ orders/[id] ▸ route.ts`. Folder yang
    berisi satu *berkas* tidak dipadatkan — berkas itu isinya, bukan jalan
    menuju isinya
  - Pemadatan ini juga berlaku di daftar berkas panel commit. Di sidebar
    hampir tidak terasa karena di sana yang tunggal biasanya berupa cabang
    (daun), bukan folder
- Mengetik di kotak **Filter files** selalu mendatarkan daftar: pohon folder yang
  isinya sudah tersaring habis hanya menyisakan folder kosong yang menyesatkan
- Stage / unstage per file atau semuanya
- **Stage, unstage, dan discard per hunk** langsung dari diff viewer
- Diff dengan nomor baris ganda (lama/baru) dan penghitung +/−
- Commit, amend, dan `Ctrl+Enter` untuk commit cepat
- Discard selalu minta konfirmasi dulu

**Commit merge**
- `git diff-tree <merge>` tanpa keterangan tambahan **tidak mengeluarkan apa
  pun** — git menolak menebak, karena sebuah merge punya dua induk dan "apa
  yang berubah" jadi ambigu. Itu sebabnya baris merge dulu tampil kosong
- Panel kanan sekarang menawarkan ketiga pertanyaan itu, lengkap dengan jumlah
  berkasnya, jadi sisi yang kosong sudah terlihat sebelum diklik:

  | Tombol | Perintahnya | Artinya |
  |---|---|---|
  | **From `<cabang>`** (bawaan) | `<hash>^1..<hash>` | seluruh isi yang dibawa masuk merge ini |
  | **Other side** | `<hash>^2..<hash>` | yang cabang tujuan punya, yang cabang sumber tidak |
  | **Resolved by hand** | `--cc` | hanya yang beda dari **kedua** induk — keputusan manusia saat merge; kosong kalau merge-nya bersih |

- Kedua induk ditampilkan sebagai chip `ONTO …` dan `FROM <cabang> …`, bisa
  diklik untuk melompat ke commit itu
- Diff gabungan (`--cc`) kini bisa dibaca viewer: formatnya berbeda — `@@@`
  dengan **dua** kolom penanda — dan tiap baris menunjukkan asalnya:
  `- ` dari induk pertama, ` -` dari induk kedua, `++` hasil akhirnya

**Konflik dan operasi yang tertunda**
- Konflik tidak mengakhiri perintah git, ia **menggantungkannya** — dan
  gantungan itu bertahan meski aplikasi ditutup. GitBraid membaca `MERGE_HEAD`,
  `rebase-merge/`, `CHERRY_PICK_HEAD`, dan `REVERT_HEAD` langsung dari `.git`
  pada tiap refresh, lalu memasang strip melintang di bawah toolbar:
  *"Merging sisi · 2 conflicts left"*, atau *"Rebasing kerja · step 1 of 2"*
- Tombol **Abort** dan **Continue** ada di strip itu. Continue mati sampai
  semua konflik beres; Abort minta konfirmasi dan menyebutkan apa yang hilang
- Berkas konflik punya grupnya sendiri, **Conflicts**, di atas Staged dan
  Changes — itu bukan "perubahan yang mungkin Anda commit", itu pekerjaan yang
  harus selesai dulu
- Per berkas: **Keep your version** (`checkout --ours`), **Keep their version**
  (`--theirs`), dan **Mark resolved** untuk berkas yang sudah Anda sunting
  sendiri. Ketiganya diakhiri `git add`, karena itulah yang memberi tahu git
  bahwa konfliknya selesai
- Tombol Commit terkunci selama masih ada konflik dan berbunyi *"2 conflicts
  left"* — git memang menolak commit pohon yang setengah ter-merge, jadi tombol
  yang mengundangnya cuma jebakan
- Membuka berkas konflik menampilkannya **utuh beserta penanda**
  `<<<<<<<` / `=======` / `>>>>>>>`. Tampilan itu tidak memakai bahasa +/−
  dan tidak menawarkan tombol hunk: git hanya bisa menyatakan berkas utuh
  sebagai "semua baris ditambahkan", dan mewarnainya hijau semua akan
  mengklaim sesuatu yang tidak benar

**Pull saat riwayat bercabang**
- Pull mencoba fast-forward dulu — satu-satunya hasil yang tidak menggabungkan
  maupun menulis ulang apa pun
- Kalau tidak bisa, GitBraid bertanya, menyebutkan angkanya: *"main has 1 commit
  of its own, and origin/main has 2 you do not have"*, lalu menawarkan **Merge**
  atau **Rebase** beserta akibat masing-masing. Bentuk riwayat Anda tidak
  diputuskan diam-diam

**Tidak ada yang keluar dari mesin Anda**
- GitBraid hanya bicara dengan `git` di komputer Anda. Satu-satunya hal yang
  pernah menghubungi pihak ketiga adalah foto penulis commit dari Gravatar, dan
  itu kini **mati secara bawaan**: meminta gambarnya berarti memberi tahu
  gravatar.com alamat IP Anda dan hash email semua orang yang commit-nya Anda
  baca — termasuk rekan kerja, di repo kantor sekalipun
- Titik berwarna lane menyampaikan hal yang sama tanpa jaringan. Kalau memang
  menginginkan fotonya, nyalakan di Preferences → UI customization
- Terverifikasi dengan menyadap seluruh permintaan jaringan aplikasi: **nol**
  permintaan keluar saat bawaan

**Saat git tidak melakukan apa-apa**
- Merge cabang yang sudah tergabung, pull yang tidak ketinggalan apa pun, dan
  rebase yang sudah di puncak semuanya **berhasil** menurut git dan tidak
  mengubah apa pun. GitBraid membaca keluarannya dan mengatakan itu apa adanya
  — *"fitur is already in this branch — nothing to merge"* — bukan "Merged"
  dengan gaya sukses untuk sesuatu yang tidak terjadi
- Menu klik-kanan menyebutkannya lebih dulu: entri merge diberi keterangan
  **— already merged**, dengan penjelasan saat di-hover. Datanya dari
  perhitungan yang sama dengan ghost badge, jadi tidak ada biaya tambahan
- Entrinya **tetap bisa diklik**. Perhitungan itu hanya melihat commit yang
  sudah dimuat, jadi ia dipakai untuk menjelaskan, bukan untuk menghalangi

**Branch dan remote**
- Checkout, buat, hapus (dengan fallback force kalau belum ter-merge)
- Merge dan rebase lewat klik kanan di sidebar
- Fetch, pull (`--ff-only`), push, dan force push pakai `--force-with-lease`
- Badge jumlah commit ahead/behind di tombol Pull dan Push

**Commit**
- Checkout, branch dari sini, tag, cherry-pick, revert
- Reset mixed atau hard, dengan peringatan yang menyebutkan konsekuensinya
- Salin SHA lengkap

**Stash**
- Simpan (opsional termasuk untracked), apply, pop, drop

**Penanda ahead / behind di Pull dan Push**
- Angka di bahu tombol, dengan cincin setebal 2px berwarna latar toolbar supaya
  terpisah jelas dari ikon panah di bawahnya
- Dua arah, dua warna: **Push** memakai indigo aksen (kerja Anda, siap dikirim),
  **Pull** memakai amber (ada yang menunggu diambil)
- Warnanya ditetapkan per tema dan **diukur**, bukan diturunkan dari `--accent`:
  di tema terang, teks putih di atas `--accent` hanya mencapai 4,13:1, di bawah
  syarat 4,5:1 untuk teks kecil. Nilai yang dipakai sekarang 5,07–8,36:1 di
  semua kombinasi
- Angkanya punya penjelasan sendiri saat di-hover, misalnya *"12 commits of
  yours are not on origin/main yet"* — angka telanjang tidak memberi tahu apa
  yang dihitungnya
- Lebar tombol tidak berubah saat penanda muncul atau hilang, dan penanda
  disembunyikan selama tombol itu sedang menjalankan perintahnya sendiri

**Umpan balik saat perintah git berjalan**
- Hanya **satu** tempat yang menggambar kemajuan pada satu waktu: tombol yang
  memulai perintahnya, atau — untuk clone dari halaman awal, yang belum punya
  tombol pemilik — bilah di status bar. Satu pendengar `repo:progress` dengan
  dua cabang, supaya keduanya tidak pernah menyala bersamaan

- Tombol yang Anda tekan berubah jadi indikatornya sendiri: ikonnya jadi
  spinner, labelnya menyebutkan tahap dan persen yang dilaporkan git
  (`Receiving 62%`, `Resolving 100%`). Lebarnya dikunci selama aksi supaya
  toolbar tidak bergoyang tiap angkanya berubah.
- Garis progres tipis di kaki toolbar mengikuti persen itu. Untuk perintah yang
  tidak melaporkan persen — checkout, merge, rebase — garisnya menyapu.
- Tombol git lain terkunci selama satu perintah berjalan, karena dua perintah
  git di satu repo memang berebut `index.lock`. Tombolnya tetap menjawab saat
  di-hover, menjelaskan sedang menunggu apa.
- Selesai: centang hijau ~1,3 detik. Gagal: silang merah, dan alasannya di
  status bar.
- Angka persennya berasal dari `git --progress` yang sungguhan, bukan animasi
  yang pura-pura tahu. Perintah yang melaporkannya: `fetch`, `pull`, `push`,
  `clone`, serta fetch/push per-cabang dari menu klik-kanan.
- Pesan galat mengambil baris yang benar-benar menjelaskan. Push yang ditolak
  membuka keluarannya dengan `To <url>` yang tidak berarti apa-apa; yang
  ditampilkan `Rejected: main -> main (non-fast-forward)`. Merge yang bentrok
  menampilkan `CONFLICT (content): Merge conflict in a.txt`, bukan
  `Command failed: git merge`.

**Preferences** (tombol gear, atau `Ctrl+,`)

Empat halaman. Setiap kendali di sini mengubah perilaku yang nyata — tidak ada
setelan yang hanya jadi hiasan.

- **General** — selang auto-fetch (0–60 menit, 0 mematikannya), prune saat
  fetch, berapa commit dimuat sekali baca, buka lagi repo terakhir saat start,
  nama branch default untuk repo baru, dan jalan pintas ke activity log.
- **Profiles** — nama dan email Git, global maupun khusus repo yang sedang
  terbuka, dengan lokasi berkasnya disebutkan (`~/.gitconfig` atau
  `.git/config`).
- **UI Customization** — tema, zoom, label di bawah ikon toolbar, gaya tanggal
  (`08/17/2026 @ 10:55 PM` atau `2h ago`), ghost badge dan deskripsi commit saat
  hover, serta kolom mana yang tampil.
- **Editor** — font, ukuran font, lebar tab, nomor baris, syntax highlight, dan
  keadaan awal setiap diff (split, wrap, ignore whitespace, show all lines),
  ditambah perintah editor eksternal.

Dua setelan ditulis ke config Git Anda sendiri, bukan ke penyimpanan GitBraid,
supaya command line ikut sepakat: nama branch default jadi `init.defaultBranch`
dan editor eksternal jadi `gitbraid.editor` — keduanya `--global`. Mengosongkan
isiannya menghapus kunci itu, bukan menyimpannya kosong. GitBraid hanya boleh
menulis dua kunci ini; kunci lain ditolak.

**Terminal**
- Panel di bagian bawah jendela, buka/tutup dengan `Ctrl+\`` atau tombol di
  pojok kanan bawah. Tinggi dan keadaan buka/tutupnya diingat antar sesi.
- Perintah dijalankan di repository tab yang sedang aktif — judul panel selalu
  menyebutkan direktori mana yang dipakai.
- `↑` / `↓` menelusuri riwayat perintah dalam sesi itu.
- Satu perintah sekaligus; `Stop` mengirim `SIGTERM` ke yang sedang jalan.
- Scrollback dibatasi 5.000 baris, dan posisi gulir dibaca dari peristiwa
  `scroll`, bukan diukur ulang tiap baris — mengukur `scrollHeight` per baris
  memaksa layout ulang seluruh panel, yang membuat 2.000 baris memakan 2,7
  detik. Sekarang 34 ms.
- **Ini penangkap keluaran, bukan pseudo-terminal.** `git`, `npm`, `ls`, `make`
  berjalan normal. Program layar penuh yang butuh TTY (`vim`, `top`, `less`,
  prompt password interaktif) tidak. PTY sungguhan butuh `node-pty` + `xterm.js`,
  dua dependency native yang harus di-rebuild tiap rilis Electron, dan GitBraid
  sengaja tidak punya dependency runtime sama sekali. Tombol di panel membuka
  terminal desktop kalau butuh yang sebenarnya.

**Activity log**
- Setiap perintah git yang dijalankan GitBraid, terbaru di atas, lengkap dengan
  waktu dan lamanya dalam milidetik. 400 perintah terakhir disimpan.
- Tiga keadaan dibedakan: berhasil, gagal dengan pesan `stderr` (merah), dan
  gagal tanpa pesan apa pun — misalnya `git config --get-regexp` yang keluar
  dengan kode 1 karena memang tidak menemukan apa-apa, ditandai `exit 1` saja
  supaya tidak terbaca seperti masalah.
- `Copy` menyalin seluruh log sebagai teks yang bisa ditempel ke laporan bug.

**Status bar kanan bawah**
- Tombol terminal dan activity log.
- Zoom `−` / `+`, dengan angka persennya; klik angkanya untuk kembali ke 100%.
- Logo GitBraid dan nomor versi; klik untuk membuka halaman proyek, release
  notes, atau About. Alamat halaman proyek dibaca dari `homepage` di
  `package.json` — selama masih kosong, entri itu ada tapi mati dan menjelaskan
  kenapa saat di-hover.

**Pintasan keyboard**

| Tombol | Aksi |
|---|---|
| `Ctrl+T` | Tab baru (halaman depan) |
| `Ctrl+O` | Buka repository |
| `Ctrl+W` | Tutup tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Tab berikutnya / sebelumnya |
| `Ctrl+F` | Cari commit |
| `Ctrl+N` | Clone dari URL |
| `Ctrl+I` | Buat repository baru |
| `Ctrl+J` / `Ctrl+K` | Sembunyikan panel kiri / panel detail commit |
| `Ctrl+=` / `Ctrl+-` | Perbesar / perkecil seluruh tampilan (58%–207%) |
| `Ctrl+0` | Kembali ke ukuran normal |
| `Ctrl+/` | Daftar pintasan keyboard |
| `Esc` | Tutup lapisan teratas: menu, log, preferensi, About, diff |
| ``Ctrl+` `` | Buka / tutup panel terminal |
| `Ctrl+,` | Preferences |
| `Alt+O` / `Alt+T` | Buka di file manager / terminal |
| `F5` atau `Ctrl+R` | Muat ulang |
| `f` | Fetch |
| `p` | Pull |
| `Shift+P` | Push |
| `b` | Branch baru |
| `Ctrl+Enter` | Commit (saat kursor di kotak pesan) |

---

## Batasan yang perlu diketahui

Ini prototipe yang berfungsi, bukan pengganti GitKraken. Yang belum ada:

- **Interactive rebase.** Tidak ada UI drag-and-drop untuk squash/reorder commit.
- **Integrasi GitHub/GitLab.** Tidak ada pull request, issue, atau review.
- **Blame, file history, dan pencarian commit.**
- **Submodule dan Git LFS.**
- **Terminal sungguhan.** Panel terminal menangkap keluaran perintah, bukan
  menyediakan TTY, jadi program layar penuh tidak bisa dipakai di dalamnya.
- **Virtualisasi daftar commit.** Di atas ±5.000 baris, scroll mulai terasa berat
  karena semua baris dirender sekaligus.

**Soal autentikasi:** `GIT_TERMINAL_PROMPT=0` sengaja diset supaya aplikasi tidak
menggantung menunggu prompt password yang tidak kelihatan. Konsekuensinya, push
dan pull ke remote HTTPS akan langsung gagal kalau kredensialnya belum tersimpan.
Pakai SSH key, atau siapkan credential helper dulu:

```bash
git config --global credential.helper store
```

---

## Struktur kode

```
main.js              Proses utama Electron. Semua perintah git dan parser-nya.
preload.js           contextBridge dengan whitelist channel IPC.
src/graph.js         Algoritma penempatan lane + renderer SVG.
src/diff.js          Parser unified diff + rekonstruksi patch per-hunk.
src/renderer.js      State, rendering, dan seluruh aksi UI.
src/highlight.js     Tokenizer syntax highlight (tanpa dependency).
src/releases.js      Isi halaman release notes, sebagai data.
src/styles.css       Tema.
test/parsers.test.js Test suite.
```

Renderer berjalan dengan `contextIsolation` menyala, `nodeIntegration` mati, dan
Content Security Policy yang ketat. Semua yang masuk ke DOM lewat innerHTML
sudah di-escape, termasuk tanda kutip — nama branch dan path file boleh
mengandungnya, dan keduanya dipakai di dalam atribut.

**Satu-satunya koneksi keluar adalah Gravatar.** CSP mengizinkan `img-src` ke
`www.gravatar.com` supaya dot di graph bisa memuat avatar penulis. Yang dikirim
adalah SHA-256 dari alamat email tiap penulis commit, sekali per alamat lalu
di-cache. Kalau Anda tidak mau itu, hapus kedua host gravatar dari tag CSP di
`src/index.html`: avatar gagal dimuat tanpa error dan dot kembali jadi lingkaran
polos berwarna lane.

Perintah git dijalankan pakai `execFile` dengan array argumen — bukan string
shell — jadi nama file dengan spasi, tanda kutip, atau karakter aneh lainnya
tetap aman. Parsing status dan log memakai format `-z` (pemisah NUL) supaya nama
file dengan newline pun tidak merusak parser.

## Menambah perintah git baru

Tiga langkah:

1. Daftarkan handler di `main.js`:
   ```js
   handle('repo:namaAksi', async (repo, arg) => git(repo, ['subcommand', arg]));
   ```
2. Tambahkan `'repo:namaAksi'` ke `CHANNELS` di `preload.js`.
3. Panggil dari `renderer.js` dengan `await call('repo:namaAksi', repoPath(), arg)`,
   lalu `await refresh()`.

Helper `handle()` sudah membungkus semua error jadi `{ok:false, error}`, dan
`call()` di renderer otomatis menampilkannya di status bar.

## Lisensi

MIT.
