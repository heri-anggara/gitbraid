> **Catatan teknis GitBraid — dalam bahasa Indonesia.**
>
> Ini dokumen kerja: alasan di balik keputusan, angka hasil pengukuran, dan
> jebakan yang ditemui sepanjang pengembangan. Untuk gambaran umum, unduhan,
> dan cara memasang, lihat [README](../README.md).

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
- Kolom pencarian **selalu terlihat** di atas riwayat, sebentuk dengan kotak
  *Filter files* di panel kanan supaya kedua pencarian di jendela ini berperilaku
  sama. `Ctrl+F` memindahkan kursor ke sana dan menyorot isinya, bukan
  memunculkannya; `Esc` mengosongkan pencarian, bukan menyembunyikan kolomnya —
  tidak ada lagi yang perlu disembunyikan. Mencari di judul, isi
  pesan, nama penulis, email, dan SHA
- Yang cocok disorot dan yang tidak cocok diredupkan (bukan disembunyikan,
  supaya garis graph di sebelahnya tidak putus)
- Penghitung `3 of 12`, `Enter` / `Shift+Enter` atau tombol ↑ ↓ untuk lompat
  antar hasil. Tombol bersihkan hanya muncul kalau ada yang diketik, dan tombol
  ↑ ↓ mati kalau hasilnya kurang dari dua

**Alamat remote**
- Menu repo (panah di kepala panel kiri) punya **Change origin URL…**; pada repo
  yang belum punya remote, item itu berbunyi **Add a remote…** dan langsung
  membuatkannya — `set-url` pada nama yang belum ada justru error, bukan
  melakukan hal yang jelas dimaksud
- Ini **tidak menyentuh riwayat sama sekali**. URL remote hanyalah catatan di
  `.git/config` tentang ke mana harus push dan fetch; ia bukan bagian dari commit
  mana pun. Diuji pada repo berisi 3 commit, 2 cabang, dan 1 tag: sesudah remote
  dipindah, **seluruh SHA identik**, tag dan cabang utuh, dan push ke lokasi baru
  mendaratkan ketiga commit
- URL yang bentuknya aneh **diberi tahu, bukan ditolak** — sebuah path di komputer
  Anda sendiri adalah remote yang sah, begitu juga host yang belum pernah didengar
  GitBraid. Yang ditolak hanya URL kosong

**Diff yang sangat besar**
- Tampilan unified hanya menggambar baris yang terlihat. Diperlukan karena
  sebuah berkas dengan ribuan baris berubah menaruh puluhan ribu elemen di
  dokumen, dan browser menata ulang semuanya di tiap gulir. Terukur pada diff
  12.037 baris: median frame **93–112 ms turun jadi 7,0 ms**, node **168.235
  jadi 1.168**
- Baris yang dilewati tetap memakan ruangnya lewat baris penahan, jadi panjang
  scrollbar tidak berubah dan tidak ada yang bergeser di bawah kursor
- Ambangnya 600 baris. Di bawah itu menggambar utuh justru lebih murah daripada
  membukukan jendela — diukur, bukan ditebak: diff nyata dengan 66 hunk hanya
  529 baris dan sudah 7,1 ms tanpa perlakuan apa pun
- Yang menghalangi selama ini bukan jumlah node melainkan **tata letak tabel**:
  mematikan pewarnaan sintaks membuang 58% node dan hanya memperbaiki 9%.
  `content-visibility` juga bukan jawabannya — pada diff banyak-hunk ia justru
  memperlambat dari 7,1 ke 12,5 ms
- Prasyaratnya adalah perbaikan saklar wrap: selama baris bisa membungkus,
  tingginya bermacam-macam (20/38/56/74/110px) dan sebuah jendela tidak bisa
  dihitung. Dengan wrap benar-benar mati, semuanya 20px
- Nomor baris untuk navigasi antar blok dan peta perubahan kini dihitung dari
  diff yang sudah diurai, bukan dari DOM — dengan jendela, blok di luar layar
  sama nyatanya tapi tidak punya elemen untuk diukur
- Split ikut ber-jendela. Sempat dilewati dengan alasan "barisnya tidak bisa
  dihitung" — padahal bisa: serangkaian penghapusan di samping serangkaian
  penambahan menghasilkan sebanyak yang lebih panjang, sisanya satu baris untuk
  satu baris. Terukur pada diff 12.037 baris dalam mode split: **64,1 ms turun
  jadi 7,9 ms**, 74 baris digambar dari 9.001
- Karena split menggambar 9.001 baris dari lines yang sama yang di unified jadi
  12.001, model tata letaknya harus menghitung mode yang sedang tampil. Sebelum
  ini ia selalu menghitung unified, jadi di split penanda peta perubahan
  ditaruh pada tinggi 240.049px sementara panelnya cuma 180.049px — meleset
  makin jauh ke bawah. Sekarang model dan panel sepakat dalam 2px
- Kolom split dikunci separuh-separuh supaya garis pemisahnya tidak bergeser
  saat digulir dan **kedua sisi tetap di layar** — itu seluruh alasan orang
  membaca diff dengan cara ini. Kolom terkunci tidak bisa melar, dan baris yang
  tidak dibungkus tidak melipat, jadi baris panjang dipotong di pemisah dan
  diberi elipsis. Saklar wrap menampilkan sisanya
- Lebar kolomnya dinyatakan di `<colgroup>`, bukan diserahkan pada baris
  pertama. Tabel `table-layout: fixed` mengambil kolomnya dari baris yang
  kebetulan datang duluan — dan begitu jendelanya bergulir, baris itu adalah
  baris penahan `colspan="4"` yang tidak menyebut satu kolom pun, jadi keempat
  kolom jatuh ke seperempat-seperempat (terukur: 160/160/160/160) dan sisi kiri
  meluncur ke tengah panel. Di puncak berkas baris penahannya tidak ada, jadi
  gejalanya cuma muncul setelah menggulir
- Mematikan nomor baris dulu membuang selnya dengan `display: none`. Tabel
  terkunci dengan kolom yang dinyatakan menuntut semua barisnya berbentuk sama
  seperti pernyataannya — buang dua sel dari sebagian baris dan paruhnya berhenti
  jadi paruh. Sekarang selnya tetap ada dan dikempiskan jadi nol
- Percobaan pertama melebarkan tabelnya sampai baris terpanjang supaya panelnya
  menggulir ke samping seperti unified. **Itu keliru**: sisi seberangnya
  terdorong keluar layar dan sebagian besar baris cuma memandangi kolom kosong —
  tumpang-tindihnya hilang dengan cara membuang perbandingannya
- Memotong itu ada harganya: 8,7 ms jadi 14,2 ms per frame di diff 12.000 baris.
  Elipsisnya sendiri gratis (diukur terpisah: 14,1 ms tanpa elipsis) — yang
  berbayar `overflow: hidden`-nya. Masih di dalam anggaran 16,7 ms
- Tajuk hunk dipaksa satu baris. Ia membawa nama fungsi di belakang nomor baris,
  dan pada berkas berbaris sangat panjang itu melipat jadi dua baris — sementara
  jendela mengukur satu tajuk lalu menganggap sisanya sama tinggi
- Mode wrap ikut ber-jendela, **termasuk saat tinggi barisnya bercampur**.
  Jendelanya tidak dipotong dari satu tinggi baris melainkan dari tinggi yang
  diukur per baris. Terukur pada diff 5.848 baris split+wrap: **35,1 ms jadi
  7 ms** per frame, 62 baris digambar dari 5.848, node 57.443 jadi 331. Menekan
  tombol wrap: **786 ms jadi 268 ms**
- Mengukurnya **tidak** dengan membaca tabel yang sudah digambar — itu berbiaya
  persis sama dengan menggambarnya (786 ms). Teks yang sama ditata di satu kolom
  tersembunyi selebar sel yang sama, dengan aturan pelipatan yang sama, sekali
  tata letak: **182 ms**, dan cocok **5.848 dari 5.848 baris, meleset 0px**
- Gayanya **disalin dari sel sungguhan** saat mengukur, bukan ditulis ulang di
  stylesheet. Menulis ulang persis memakan korban: padding tegak 2px terlewat,
  dan setiap baris jadi 2px pendek
- Baris kosong digambar sebagai `&nbsp;`, jadi mengukurnya sebagai div kosong
  memberi 2px alih-alih 20px. Di split sebuah baris setinggi paruh yang lebih
  tinggi, jadi kedua paruh diukur dan diambil yang terbesar
- **Baris penahan** ikut memakai tinggi terukur itu lewat jumlah kumulatif.
  Kekeliruan di sini tidak menyalahgambarkan apa pun yang terlihat — ia membuat
  halaman berbeda tinggi dari model yang memutuskan apa yang digambar (186.611
  vs 117.529), dan diff-nya meleset di bawah kursor
- Verifikasi setelah tiap gambar: tinggi baris **dan** tinggi halaman. Versi
  pertama cuma memeriksa barisnya — yang memang benar — sementara yang salah
  justru totalnya. Kalau meleset, ukurannya dibuang dan diff digambar utuh:
  lebih lambat tapi benar. Diuji dengan sengaja merusak angkanya
- Ukuran hanya berlaku untuk lebar saat ia diambil, jadi panel yang berubah
  lebar membuangnya dan mengukur lagi. Diuji 1280→980→1280: model dan halaman
  tetap sepakat dalam 2px di ketiganya

**Memilih banyak berkas sekaligus**
- Ctrl/Cmd+klik menambah-mengurangi, Shift+klik membuat rentang, klik biasa
  memilih satu sekaligus membuka diff-nya. Ctrl+A memilih seisi daftar
- Ctrl dan Shift **tidak** mengganti berkas yang terbuka di panel: memilih
  berkas kedua bukan permintaan untuk membacanya, dan menukar panel di tiap
  Shift+klik membuat rentang mustahil dibangun
- Pilihannya **tidak disimpan sebagai kelas di DOM**. Daftar digambar ulang
  seutuhnya setiap kali ada refresh — stage, discard, berkas berubah di disk —
  jadi pilihan disimpan sebagai daftar path lalu dicatkan kembali setelah tiap
  gambar. Path yang sudah tidak ada di status ikut gugur dari pilihan
- Satu daftar saja yang memegang pilihan. Staged dan unstaged bukan dua paruh
  dari satu daftar: aksinya berbeda, dan menu yang menawarkan "stage" untuk
  berkas yang sudah ter-stage adalah menu yang berhenti bermakna
- Klik kanan di luar pilihan **memindahkan** pilihan ke baris itu, seperti
  daftar berkas mana pun — kalau tidak, menunya akan menyebut berkas yang tidak
  ada di bawah kursor dan tampak salah baca
- Tiap entri menyebut **berapa** berkas yang akan disentuh. "Discard changes"
  dan "Discard 12 files" bukan tawaran yang sama, dan selisihnya tidak bisa
  dibatalkan
- Tombol per-baris disembunyikan pada baris terpilih selama lebih dari satu
  dipilih: tombol itu akan mengenai satu berkas dan terbaca seolah mengabaikan
  sisanya
- Baris terpilih dan baris terbuka dua hal berbeda — yang satu berkata "aksi
  akan mengenai ini", yang lain "ini yang sedang ditampilkan panel". Bisa baris
  yang sama, jadi tandanya harus beda: yang terbuka berlatar penuh, yang
  terpilih diberi pita di tepi kiri

**Menggeser tab**
- Tab bisa ditekan-tahan lalu digeser ke posisi mana pun; yang lain menyingkir,
  dan urutannya tersimpan
- Memakai pointer event, **bukan** drag-and-drop bawaan peramban — yang bawaan
  memberi gambar bayangan yang tidak bisa digayakan dan sasaran jatuh yang tidak
  terlihat. Di sini tab-nya sendiri yang mengikuti kursor
- Satu arah saja: seretan memindahkan **elemen**, dan array `tabs` dibaca ulang
  dari dokumen saat dilepas. Kalau keduanya sama-sama diubah, mereka bisa
  berselisih di tengah jalan
- Saat elemen berpindah di tata letak, titik acuannya digeser sebesar
  perpindahan itu — kalau tidak, tab-nya melompat lepas dari tangan
- Kelonggaran 5px: klik selalu sedikit bergoyang, dan tanpa itu setiap klik jadi
  seretan satu piksel yang menelan klik yang dimaksud
- **Dua cacat yang sempat saya buat, keduanya membuat strip berhenti menjawab
  sama sekali**:
  - `releasePointerCapture` melempar galat untuk pointer yang tidak sedang
    ditangkap, dan itu menghentikan penangan `pointerup` di tengah — `tabDrag`
    tertinggal memegang elemen, dan itu membuat `renderTabs()` jadi tidak
    berbuat apa-apa untuk sisa sesi. Sekarang seretan dilepas **lebih dulu**,
    baru hal-hal yang bisa gagal dikerjakan, dan keduanya dibungkus
  - Penanda "baru saja diseret" menunggu klik yang tidak pernah datang (strip
    digambar ulang saat dilepas, jadi kliknya tidak punya sasaran), lalu ia
    menelan klik berikutnya — tombol tutup tab jadi mati. Sekarang penanda itu
    dihapus oleh tekanan berikutnya
- Dekat tepi, strip ikut menggulir supaya tab bisa dibawa ke tempat yang sedang
  tidak terlihat

**Menyelesaikan update**
- Unduhan **tidak lagi berakhir dengan restart**. Dulu ia langsung
  `app.relaunch(); app.quit()` begitu byte terakhir mendarat — dan update tidak
  pernah cukup mendesak untuk merebut jendela orang yang sedang di tengah merge
- Sesudah unduh: tawaran **"Restart now" / "Later"**. Kalau ditunda, pemasangan
  terjadi saat aplikasi ditutup berikutnya — saat restart tidak berbiaya apa pun
  karena programnya memang sedang berhenti. Terukur ujung-ke-ujung dengan berkas
  tiruan: tetap versi lama selama berjalan, tertukar saat keluar, hak akses 755,
  tanpa sisa `.new`
- Tombol batalnya diberi nama **"Later"**, bukan "Cancel": keduanya sama-sama
  keputusan, dan "Cancel" terdengar seperti membatalkan
- Berkas tertunda disimpan **di memori saja**. Kalau sesi berakhir dengan cara
  lain, unduhannya diambil lagi — itu lebih murah daripada menalar berkas basi
  yang tertinggal di disk
- Keluar tidak pernah terhalang oleh penukaran yang gagal: kalau gagal, versi
  yang bekerja tetap di tempatnya dan pemeriksaan berikutnya menawarkan lagi
- **`.deb` tidak bisa ditunda** — ia butuh pemasang paket sistem, bukan rename,
  dan pemasang itu minta kata sandi sendiri. Kalimatnya berbeda dan tidak
  menjanjikan restart
- Titik di tombol versi kini punya dua arti: "ada versi baru" dan "sudah
  terunduh, akan dipasang saat ditutup"

**Draf pesan commit bertahan melewati restart**
- Prasyarat bagi semua di atas. Pesan commit setengah jadi adalah satu-satunya
  hal di jendela ini yang **tidak ada di tempat lain**: riwayat kembali dari
  git, daftar berkas kembali dari git, tapi apa yang hendak Anda katakan tidak
- Dulu ia hanya dibawa antar-tab di memori lewat `parkTab()`, dan hilang begitu
  aplikasi ditutup. Terukur: tidak ada satu kunci pun di penyimpanan yang
  memuatnya, dan tidak ada kait `before-quit` maupun `beforeunload` sama sekali
- Disimpan **per repositori**, karena itu yang dimiliki sebuah pesan
- Ditulis **sambil diketik** (ditunda 400ms), bukan menunggu jendela ditutup —
  menunggu berarti kehilangannya pada persis kejadian yang ingin ia selamati.
  Ditambah satu simpanan terakhir di `beforeunload` untuk ketikan terakhir
- Draf kosong dihapus dari penyimpanan, bukan disimpan sebagai kosong — kalau
  tidak, pesan yang sudah dibersihkan akan hidup lagi. Spasi saja bukan draf,
  tapi centang amend sendirian tetap layak diingat
- Draf di memori menang atas yang tersimpan: ia yang lebih baru

**Ikon di dock terlambat muncul**
- Dock mencocokkan jendela dengan peluncurnya lewat `WM_CLASS` jendela itu, dan
  pencocokannya **peka huruf besar-kecil**
- Electron mengambil `WM_CLASS` dari nama berkas biner, yaitu `gitbraid` —
  terukur dengan `xprop`: `WM_CLASS(STRING) = "gitbraid", "gitbraid"`. Berkas
  desktop-nya menyatakan `StartupWMClass=GitBraid`, jadi cocokan langsungnya
  gagal dan shell jatuh ke tebakan cadangan (mencocokkan `WM_CLASS` dengan nama
  berkas desktop). Ikonnya tetap muncul, hanya terlambat — itu persis gejalanya
- Diuji supaya tidak melenceng lagi: `StartupWMClass` harus sama persis dengan
  nama biner, dan harus huruf kecil semua
- Yang **bukan** penyebabnya, sudah diperiksa: berkas ikon lengkap di kedelapan
  ukuran hicolor, dan tidak ada entri desktop kembar yang bentrok

**Ignore, menyesuaikan keadaan berkas**
- git **hanya** mengabaikan berkas tak terlacak. Menulis berkas terlacak ke
  `.gitignore` tidak berefek apa pun — jadi menunya menawarkan hal berbeda untuk
  keadaan yang berbeda, karena menawarkan yang salah sama dengan menawarkan
  sesuatu yang diam-diam tidak melakukan apa-apa:
  - **tak terlacak** → "Ignore this file…", dengan pilihan pola: berkas itu
    saja, semua berkas berekstensi sama, atau seisi foldernya
  - **terlacak** → "Stop tracking and ignore…" — `git rm --cached` lalu tulis ke
    `.gitignore`. Berkasnya tetap di disk, tapi penghapusannya ter-stage dan
    commit berikutnya mengeluarkannya dari repo untuk semua orang. Ada dialog
    konfirmasi yang menyebut itu
  - **terhapus** → entrinya mati: path yang sudah hilang tidak punya apa pun
    untuk diabaikan maupun dihentikan pelacakannya
  - **campuran** → tiap bagian dapat entrinya sendiri
- "Open in editor" juga mati untuk berkas terhapus — tidak ada yang bisa dibuka
- `.gitignore` dibuat kalau belum ada, pola tidak ditulis dua kali, dan berkas
  yang tidak berakhir dengan baris-baru diberi satu dulu — kalau tidak, pola
  baru akan menyambung ke baris terakhir

**File history**
- **Panel tersendiri**, bukan daftar commit utama yang disaring. Log yang
  disaring per-path menjatuhkan commit di antaranya, jadi induk yang dipakai
  graph untuk menggambar lajur tidak lagi lengkap — dan lajur yang berbohong
  lebih buruk daripada tidak ada lajur
- Kiri daftar commit yang menyentuh berkas itu, kanan diff berkas itu pada
  commit yang dipilih. Pembatasnya bisa digeser
- `--follow` membawa riwayat melewati rename — itu justru alasan utama riwayat
  berkas berguna
- **Nama berkas di tiap commit harus diambil dari log itu sendiri.** Percobaan
  pertama menanyakan `git show --follow <hash> -- <path-sekarang>` per commit:
  untuk commit sebelum rename hasilnya kosong, dan itu terbaca sebagai "commit
  ini tidak mengubah apa-apa" padahal yang diubahnya berkas bernama lain.
  `--name-status` melaporkan nama sebagaimana adanya saat itu, dan mengeja
  rename sebagai `R100 <lama> <baru>` — satu-satunya tempat nama lama muncul
- `core.quotePath=false` supaya path beraksen atau berspasi datang apa adanya,
  bukan sebagai escape
- Rename ditandai di baris tempat ia terjadi, karena `--follow` menyeberanginya
  tanpa berkata apa-apa
- **Panel diff-nya dipindahkan ke sini, bukan dibangun ulang.** Semua
  kemampuannya — toolbar, peta perubahan, navigasi antar blok, wrap,
  side-by-side, menggambar hanya baris yang terlihat — terikat pada satu elemen
  itu; salinan kedua berarti tempat kedua yang harus diperbaiki setiap kali.
  Memindahkan node mempertahankan listener-nya, jadi ia datang dalam keadaan
  bekerja. Saat panel ditutup, node-nya dikembalikan ke tempat semula dan berkas
  yang tadinya terbuka dipulihkan
- Commit yang dipilih diserahkan ke penampil sebagai **berkas di dalam sebuah
  commit** — memang begitu keadaannya. Jalur itu sudah mengambil lewat
  `repo:diffCommitFile` dan sudah menyembunyikan tombol stage, karena tidak ada
  yang bisa di-stage di masa lalu
- `grid-column: 3` milik penampil itu untuk tempatnya di tata letak utama; di
  slot riwayat itu akan mengarang dua kolom yang tidak ada, jadi ditimpa
- Tombol tutup milik penampil disembunyikan di sini: menutup diff akan
  menyisakan separuh panel kosong. Escape menutup panel riwayatnya
- Penggeser panel dibuat berbasis tabel. Dua panel sebelumnya dieja satu per
  satu di dalam kondisi; panel ketiga harus dieja lagi, dan satu kondisi
  terlewat berarti menggeser panel yang salah

**Aksi atas banyak berkas**
- Discard memisahkan yang terlacak dari yang tidak, karena itu dua perintah
  berbeda — satu memulihkan berkas, satu menghapusnya — dan peringatannya
  menyebutkan keduanya. Menghapus berkas tak terlacak adalah satu-satunya hal
  di sini yang git tidak menyimpan salinannya di mana pun
- Stash sebagian memakai `git stash push -- <paths>`. Berkas tak terlacak butuh
  `-u`, kalau tidak git meninggalkannya tanpa berkata apa-apa — dan itu akan
  tampak seperti stash yang diam-diam melewatkannya
- Save as Patch memakai `git diff [--cached] -- <paths>`. `git diff` hanya
  melaporkan perubahan terlacak, jadi berkas tak terlacak tidak bisa masuk:
  entrinya dimatikan kalau semuanya tak terlacak, dan jumlah yang ditinggalkan
  disebutkan setelah berkas tersimpan. Diuji: hasilnya lolos `git apply --check`
- **Semua perintah ini berakhir dengan `-- <paths>`.** Diberi daftar kosong,
  pathspec-nya lenyap dan perintahnya mengenai seluruh working tree, bukan
  berkas yang disebut menu. Ketiganya menolak daftar kosong, string kosong, dan
  nilai bukan-string; sebuah string telanjang tidak dipecah jadi huruf. Diuji
  dengan memanggil ketiganya lewat IPC: tiga-tiganya ditolak dan tidak satu
  berkas pun berubah

**Catatan rilis di dialog update**
- Isi rilis GitHub itu Markdown yang ditulis untuk halaman web, dan dialognya
  dulu mencetaknya **mentah** di dalam `<pre>` — jadi tabel pengukuran datang
  sebagai dinding pipa dan setiap `**kata**` masih membawa tanda bintangnya
- Sekarang dirender: judul, penekanan, kode sebaris, daftar berbutir dan
  bernomor, garis, dan tabel. Yang tidak dikenali dibiarkan apa adanya
- **Di-escape dulu, dicocokkan belakangan.** Isinya berasal dari halaman yang
  bukan aplikasi ini yang menentukan isinya, jadi tidak boleh ada yang bisa
  menanam markup ke jendela. Diuji dengan `<img src=x onerror=...>`: nol tag
  tertanam, skrip tidak berjalan, teksnya tetap terbaca
- Dialognya dilebarkan (`clamp(460px, 46vw, 720px)`) khusus saat memuat catatan
  rilis, dan kolom angka tidak boleh terpotong — dengan lebar dialog tanya-jawab
  biasa, "268 ms" pecah jadi dua baris
- **Perlu diingat saat menulis catatan rilis:** yang melihat dialog ini selalu
  memakai versi **lama**. Perbaikan renderer ini baru terasa mulai rilis
  sesudahnya, jadi isi rilis tetap harus enak dibaca sebagai teks polos

**Palang gulir horizontal**
- Mode unified tanpa wrap memakai bilah gulir horizontal yang **selalu terlihat**
  di bawah panel, bukan bilah bawaan yang menunggu di dasar konten ratusan ribu
  piksel di bawah. Bilah ini cermin dua arah dari `scrollLeft` panel: seret,
  klik palung, atau shift-roda, dan panelnya ikut — dan sebaliknya
- Bilahnya hanya muncul kalau memang ada yang lebih lebar dari panel (di split
  tidak ada: baris panjang dipotong dengan elipsis)

**Peta perubahan sebagai palang gulir**
- Strip di kanan panel diff kini satu-satunya penunjuk posisi: palang gulir
  tegak bawaan disembunyikan. Dua penunjuk hal yang sama berdampingan cuma bisa
  sejajar secara kebetulan, dan memang tidak sejajar
- Kotak posisinya dulu ditaruh dengan persen (`scrollTop / tinggiIsi`) sementara
  tingginya dijepit minimum lewat CSS. Sebuah minimum harus diambil dari jarak
  tempuhnya: di dasar berkas kotak itu menggantung **8px lewat ujung strip**,
  sedangkan palang gulir di sebelahnya berhenti pas. Sekarang dihitung dalam
  piksel dengan rumus yang dipakai setiap palang gulir — dan ketika tingginya
  tidak sedang dijepit, rumus itu menyederhana persis jadi persen yang lama
- Strip-nya bisa diseret seperti palang gulir sungguhan, dengan kelonggaran 4px
  supaya klik pada penanda tetap terbaca sebagai klik
- Penandanya sendiri ternyata **tidak pernah salah** — pada diff uji mereka
  duduk di 36,6%–44,1% dan 90,5%, persis di mana perubahannya berada

**Saat aksi git gagal**
- Kegagalan aksi git memunculkan **dialog**, bukan cuma satu baris di status bar
  yang tergeser pesan berikutnya. Judulnya menyebut apa yang sedang dikerjakan,
  di bawahnya alasan yang **menjelaskan** — bukan baris pertama, karena git
  membuka push yang ditolak dengan `To <url>` dan alasannya tiga baris di bawah
- Seluruh keluaran git ditampilkan apa adanya di bawahnya, dalam urutan aslinya
  dan tanpa satu baris pun dibuang. Termasuk *hint* dari git sendiri, yang justru
  sering memberi tahu langkah berikutnya. Teksnya bisa diseleksi, karena hal
  pertama yang orang lakukan dengan pesan galat adalah menyalinnya
- **Finish menolak tag yang namanya sudah dipakai sebelum menyentuh apa pun.**
  Dulu ia gagal di langkah penandaan — sesudah produksi ter-merge — sehingga
  meninggalkan keadaan setengah jadi: main berubah, tanpa tag, development belum
  menerima apa pun, cabangnya masih ada. Padahal memakai ulang nomor versi itu
  kekeliruan yang wajar

**Repository management**
- Tombol **Browse / Clone / Init / Scan a folder…** masing-masing membawa ikon,
  dan tombol tutupnya setinggi tombol lain. Sebuah glyph lebih pendek daripada
  sebaris teks, jadi tombol ikon yang dibiarkan mengikuti isinya berdiri
  dua-pertiga tinggi tetangganya — ia sekarang diberi kotak yang sama: satu
  baris ditambah padding dan border milik `.btn`
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
  hapusan, dan terbelah kiri-kanan kalau blok itu melakukan keduanya. Warnanya
  sepasang token tersendiri, bukan warna teks diff: warna teks disetel supaya
  terbaca sebagai tulisan, dan sebagai blok padat ia jatuh kusam. Tinggi penandanya
  sebanding dengan besar bloknya, dan blok yang sedang Anda lihat diberi bingkai.
  Jalurnya memakai latar diff itu sendiri tanpa garis pembatas, jadi terbaca
  sebagai tepi diff — bukan gutter yang ditempelkan
- Sebuah kotak transparan menandai bagian berkas yang sedang terlihat di layar,
  jadi jalur itu menjawab "di mana saya" sekaligus "di mana perubahannya". Ia
  duduk di bawah penanda, supaya tidak pernah menutupi satu pun perubahan
- **Kalau seluruh diff sudah muat di layar, jalurnya dibiarkan kosong.** Peta
  yang tugasnya menunjukkan perubahan yang *tidak* terlihat tidak punya apa pun
  untuk ditunjuk saat semuanya terlihat — dan karena tinggi penanda sebanding
  dengan isi, pada diff pendek ia justru jadi paling mencolok: diperiksa pada
  diff `+16 −1`, dua penanda memakan **47,7%** jalur padahal tidak ada satu
  baris pun yang tersembunyi. Ujinya sama persis dengan yang sudah dipakai kotak
  posisi layar, yang selama ini jadi satu-satunya bagian jalur yang tahu diri
- Tinggi satu penanda dibatasi **seperempat** jalur. Pada diff normal penanda
  hanya 1–3% sehingga batas itu tidak pernah terpakai; ia ada untuk diff yang
  hanya bisa digulir sedikit, di mana satu blok bisa mengisi hampir seluruh
  berkas. Terukur pada kasus seperti itu: 85% tanpa batas, 25% dengan batas —
  selisih antara sebuah balok dan sebuah penanda
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

**Kepala panel kiri**
- Satu kotak berisi dua baris: repo di atas, cabang yang sedang di-checkout di
  bawah. Ikon menggantikan label kapital REPOSITORY dan BRANCH yang dulu memakan
  satu baris masing-masing — kotaknya jadi 64px dari sebelumnya sekitar 93px
- Hanya baris repo yang bisa diklik, dan hanya baris itu yang berperilaku seperti
  tombol: ada kursor penunjuk, hover, dan panah di kanannya. Baris cabang adalah
  keterangan, bukan kontrol; dulu ia punya batas dan efek hover yang menjanjikan
  sesuatu yang tidak pernah ada
- Saat HEAD terlepas dari cabang mana pun, baris itu berbunyi `detached HEAD`
  dalam warna peringatan

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
- Apakah cabangnya ada di remote **ditanyakan ke remote**, bukan dibaca dari ref
  pelacak lokal. Ref pelacak hanya sesegar fetch terakhir: cabang yang di-push
  dari komputer lain, atau yang ref-nya sudah dipangkas, membuatnya menjawab
  "tidak ada" padahal ada. Ditanyakan hanya kalau jawaban lokalnya "tidak" —
  kalau lokal bilang ada, tidak ada yang perlu dipastikan lagi
- Pertanyaan itu dikirim **sesudah** dialognya tampil, tidak pernah sebelumnya.
  Satu perjalanan ke remote lewat ssh memakan sekitar **3 detik**, dan dulu
  waktu itu dihabiskan dengan layar kosong — menunggu tiga detik untuk diberi
  tahu, hampir selalu, bahwa tidak ada apa-apa di sana. Terukur: dialog muncul
  dalam **2.930 ms**, sekarang **10 ms**. Centang hapus-remote sudah ada di DOM
  sejak awal dalam keadaan tersembunyi, lalu muncul sendiri kalau jawabannya
  "ada"; `collect()` membacanya apa pun keadaannya, jadi kotak yang belum
  sempat muncul bernilai `false` — sisi yang aman
- Ada **tiga** kemungkinan jawaban, dan yang ketiga penting: ada, tidak ada, dan
  *tidak bisa ditanyakan*. Saat offline dialognya berkata apa adanya bahwa
  jawabannya tidak diketahui, bukan berpura-pura cabangnya tidak ada. Pertanyaan
  itu dibatasi 8 detik dan memakai `ssh -oBatchMode=yes`, karena ia berjalan
  sementara dialog menunggu terbuka dan remote yang meminta kata sandi akan
  menggantung di situ tanpa penjelasan apa pun di layar
- Kalau orang lain sudah menghapus cabang itu lebih dulu, hasilnya berbunyi
  *"was already gone"* dan finish tetap dianggap berhasil — itu memang hasil yang
  diminta, dan menggagalkannya akan membuat finish yang sudah merge, tag, dan
  push tampak seperti gagal
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
- Foto diambil dari **GitHub** kalau alamat commit-nya alamat terbitan GitHub
  (nomor akunnya ada di dalam alamat itu), dan dari **Gravatar** untuk alamat
  lain. Keduanya di balik satu saklar yang mati secara bawaan
- **Di mana wajah penulis muncul** bisa dipilih di Preferences: pada dot graph,
  di kolom Author, di keduanya, atau tidak sama sekali. Di kolom Author, commit
  yang tidak punya Gravatar tetap mendapat cakram inisial berwarna — hurufnya
  dari nama, warnanya dari alamat email, jadi orang yang sama selalu berwarna
  sama, dan seluruhnya dihitung di komputer Anda tanpa menyentuh jaringan. Dot
  graph hanya berdiameter 16px dengan ruang 13px di dalamnya: cukup untuk gambar,
  tidak cukup untuk huruf, jadi di sana hanya Gravatar yang bisa muncul
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
    mengiringi di sebelahnya dengan warna redup:
    `printpdf.js  code/apps/v1/controllers/cms`. Jadi dua berkas bernama sama di
    folder berbeda — misal `route.ts` di `api/orders/[id]` dan di
    `api/products/[id]` — tetap bisa dibedakan tanpa perlu hover. Nama berkasnya
    tidak pernah ikut terpotong; yang dipangkas foldernya, dan dipangkas dari
    **depan**, supaya folder terdekat dengan berkasnya yang selamat:
    `…at/keeps/going/for/quite/a/while/indeed`
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
- **Blame dan file history.**
- **Submodule dan Git LFS.**
- **Terminal sungguhan.** Panel terminal menangkap keluaran perintah, bukan
  menyediakan TTY, jadi program layar penuh tidak bisa dipakai di dalamnya.
- **Penyaring di sidebar.** Cabang, tag, remote, dan stash hanya bisa dicari
  dengan menggulir. Pada repo dengan ratusan tag itu terasa; commit, berkas,
  repo, dan tab masing-masing sudah punya kotak pencarian sendiri, sidebar
  belum.

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

**Pembaruan dalam aplikasi.** Ada dua jalan masuk: **Help ▸ Check for Updates…**
untuk bertanya kapan saja, dan tombol versi di status bar yang mendapat titik
kalau ada rilis lebih baru. Ditanya lewat menu, jawaban "ada" langsung berupa
tawarannya — menandai status bar lalu diam adalah menjawab pertanyaan yang tidak
diajukan siapa pun.

Tombol versi di status bar mendapat titik kalau ada
rilis lebih baru; mengkliknya menampilkan catatan rilisnya dan satu tombol.
Pemeriksaannya sekali sehari saat aplikasi dibuka, ada saklarnya di Preferences,
dan yang diketahui GitHub hanya alamat IP Anda serta fakta bahwa GitBraid
berjalan — tidak ada nama repo, berkas, atau apa pun dari kerja Anda.

Apa yang bisa dilakukan bergantung pada bentuk pasangannya:

| bentuk | yang terjadi |
|---|---|
| **AppImage** | diunduh, checksum dicocokkan, berkasnya diganti, aplikasi jalan ulang — otomatis penuh |
| **.deb** | diunduh, checksum dicocokkan, lalu diserahkan ke pemasang sistem yang meminta kata sandi Anda. Memasang paket sistem butuh hak yang aplikasi ini tidak punya dan tidak sepatutnya minta |

Unduhan **selalu** dicocokkan dengan SHA-512 dari `latest-linux.yml` yang dibuat
electron-builder. Kalau berkas itu tidak dilampirkan ke rilis, pembaruan
**ditolak** — bukan dipasang atas dasar percaya. Ini mengganti program yang Anda
jalankan; itu terlalu penting untuk ditebak. Jadi setiap rilis wajib melampirkan
`dist/latest-linux.yml` bersama artefaknya.

Seluruhnya ditulis dengan `https` bawaan Node dan `crypto` bawaan Node.
`electron-updater` akan lebih singkat, tapi ia membawa belasan paket sebagai
dependensi runtime — dan pada Linux ia tetap tidak bisa memasang `.deb`, hanya
memberi tahu. Ongkos besar untuk hasil yang tidak lebih baik di jalur yang
dipakai.

**Selain pembaruan, satu-satunya koneksi keluar adalah foto penulis**, dan itu
pun mati secara bawaan. CSP mengizinkan `img-src` ke `www.gravatar.com` dan
`avatars.githubusercontent.com`, tidak ke tempat lain. Yang dikirim adalah
SHA-256 alamat email, atau nomor akun GitHub — sekali per alamat lalu di-cache.
Kalau Anda tidak mau itu, hapus ketiga host tersebut dari tag CSP di
`src/index.html`: foto gagal dimuat tanpa error dan yang tersisa adalah cakram
inisial.

**Yang perlu dipahami tentang avatar itu:** git tidak menyimpan gambar apa pun.
Sebuah commit hanya berisi nama dan alamat email. GitBraid tidak pernah bertanya
ke GitHub maupun GitLab — foto yang Anda unggah ke GitHub ada di server GitHub
dan tidak pernah diminta dari sini. Satu-satunya yang ditanya adalah Gravatar,
dan jawabannya hanya berarti "alamat ini terdaftar di gravatar.com".

Ada dua sumber, dan keduanya dipilih dari alamat email commit itu sendiri:

- Alamat terbitan GitHub — `73584729+nama@users.noreply.github.com` — membawa
  **nomor akunnya** di depan tanda plus, dan nomor itu sudah cukup untuk
  menyusun alamat fotonya di `avatars.githubusercontent.com`. Tanpa API, tanpa
  token, tanpa pencarian nama. Alamat noreply terbitan sebelum 2017 hanya
  memuat username; itu dilewati, karena menyelesaikannya butuh redirect lewat
  `github.com` — satu host lagi di CSP — demi bentuk yang sudah bertahun-tahun
  tidak dipakai
- Alamat lain ditanyakan ke Gravatar

GitHub menjawab 200 untuk nomor apa pun — akun yang sudah dihapus mendapat tanda
abu-abu generik, bukan ketiadaan — jadi menanyakan "apakah fotonya ada" ke sana
selalu dijawab ya, dan pertanyaan itu tidak dibuat. Untuk Gravatar sebaliknya:
permintaannya memakai `d=404`, bukan `d=identicon`. Bedanya nyata: dengan
`d=identicon`, alamat yang **tidak** terdaftar tetap dijawab dengan gambar —
sebuah pola geometris yang dikarang dari hash alamat tadi, yang tiba sebagai
gambar biasa sehingga tidak bisa dibedakan dari wajah sungguhan. Diuji langsung
ke gravatar.com memakai alamat di TLD `.invalid`, yang menurut RFC 2606 tidak
akan pernah bisa didaftarkan siapa pun:

| permintaan | jawaban |
|---|---|
| `?d=404` | tidak ada gambar |
| `?d=identicon` | ada gambar — padahal alamatnya tidak dimiliki siapa pun |

Jadi wajah yang muncul di GitBraid selalu wajah sungguhan milik seseorang, dan
alamat tanpa Gravatar mempertahankan cakram inisialnya.

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
