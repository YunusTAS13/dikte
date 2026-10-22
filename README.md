# Dikte 🎙️

Konuşmayı Türkçe canlı altyazıya dönüştüren yerel web uygulaması. Varsayılan kullanımda ses aynı bilgisayardaki sunucuda işlenir; ilk kurulumda konuşma modeli Hugging Face üzerinden indirilir.

![durum](https://img.shields.io/badge/model-faster--whisper%20large--v3--turbo-35e0b0)

## Neler yapıyor

- **Canlı yazı**: sen konuşurken ~0,4 sn'de bir tahmin ekranda güncellenir (gri italik).
- **Kararlı metin**: cümle bitip kısa bir sessizlik olunca metin kesinleşir ve bir daha değişmez.
- **Türkçe odaklı**: dil sabit `tr`, noktalama ve büyük harf modelden gelir; önceki cümle bağlam olarak verilir.
- **Otomatik yazma**: istersen kesinleşen metin, imlecinin olduğu uygulamaya yazılır (KDE Wayland'da `ydotool` ile).
- **Global kısayol**: `F9` ile nerede olursan ol kaydı başlat/durdur.
- Kopyala, `.txt` indir, temizle, kelime/karakter sayacı, gecikme göstergesi.

## Gereksinimler

- Linux (X11 veya Wayland), mikrofon ve güncel tarayıcı
- NVIDIA GPU + sürücü (CPU'ya düşer ama çok yavaş olur)
- `uv`, `ffmpeg` (kurulumda model indirme dışında gerekmez)
- Otomatik yazma için: `ydotool` + `/dev/uinput` erişimi, ya da `xdotool`

## Kurulum ve yerel kullanım

```bash
./install.sh     # Python 3.12 venv + faster-whisper + CUDA kütüphaneleri
./run.sh         # sunucuyu başlatır ve tarayıcıyı açar
```

İlk çalıştırmada model (~1.6 GB) indirilir, sonra hep yerel cache'ten yüklenir.

## Kullanım

1. `./run.sh` → `http://127.0.0.1:8765`
2. **Başlat** (veya `Boşluk` / `F9`) de ve konuş.
3. Gri yazı = canlı tahmin, beyaz yazı = kesinleşmiş metin.
4. **Otomatik yazma**yı açtıysan, imleci hedef uygulamaya koy; cümle bitince metin oraya yazılır.

## Ağda başka cihazdan kullanım

Akıllı tahta tarayıcısının sunucuya erişebilmesi için uygulamayı GPU/modelin bulunduğu Linux bilgisayarda çalıştırın. Aynı yerel ağdan erişimi açmak için:

```bash
DIKTE_HOST=0.0.0.0 ./run.sh
```

Sunucunun LAN IP adresini `hostname -I` komutuyla bulun; tahtada `http://SUNUCU_IP:8765` adresini açın. Mikrofon erişimi uzak HTTP sayfalarında çoğu tarayıcıda engellenir. Gerçek kullanımda HTTPS reverse proxy (ör. Caddy/Nginx) ve sertifika gerekir. Portu doğrudan internete açmayın; erişim kontrolü ve okul ağı kurallarını ayrıca yapılandırın. `./run.sh`, LAN modunda sunucu bilgisayarında tarayıcı açmaz.

## GitHub Pages

`main` dalındaki arayüz değişiklikleri GitHub Actions ile otomatik olarak Pages'a dağıtılır: `https://yunustas13.github.io/dikte/`. Pages yalnızca statik arayüzdür; Whisper modeli burada çalışmaz. Sayfayı açınca **Transkripsiyon sunucusu** alanına, HTTPS ve WSS sunan Dikte sunucunuzun adresini yazıp **Bağlan**'a basın. Adres bu tarayıcıda saklanır.

Sunucu tarafında HTTPS reverse proxy ile `/` ve `/ws` uçlarını uygulamanın `127.0.0.1:8765` adresine yönlendirin. Tarayıcı güvenlik kısıtları nedeniyle GitHub Pages'tan `http://` veya şifrelenmemiş `ws://` sunucusuna mikrofon akışı gönderilemez. Sayfa dağıtımı için repo Settings → Pages → Build and deployment → Source değerinin **GitHub Actions** olması gerekir.

> Not: Otomatik yazma açıkken bu sayfa odaktaysa metin sayfaya değil panoya gider. Hedef uygulamayı odakta tut.

## Nasıl çalışıyor

```
Mikrofon ──► AudioWorklet (16 kHz mono float32) ──WebSocket──► FastAPI
                                                                 │
                                       enerji tabanlı ses/sessizlik takibi
                                                                 │
                                          faster-whisper large-v3-turbo (CUDA)
                                                                 │
                            partial (~0,4 sn)  ──►  tarayıcıda canlı metin
                            commit (sessizlik) ──►  kalıcı metin + otomatik yazma
```

- Sessizlik eşiği gürültü tabanına göre uyarlanır; sabit bir eşik yok.
- Her commit'te son 200 karakter `initial_prompt` olarak verilir; böylece noktalama/bağlam tutarlı kalır.
- Halüsinasyon filtresi: boş/anlamsız, tekrar eden veya "altyazı M.K." tipi çıktılar atılır.
- GPU'da float16, GPU yoksa CPU'da int8'e otomatik düşer.

## Ayarlar

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DIKTE_PORT` | `8765` | HTTP portu |
| `DIKTE_HOST` | `127.0.0.1` | Dinlenecek adres; LAN için `0.0.0.0` |
| `DIKTE_MODEL` | `deepdml/faster-whisper-large-v3-turbo-ct2` | faster-whisper CT2 modeli |

İnce ayar için `server.py` başındaki sabitler: `SILENCE_END`, `MAX_BUFFER`, `PARTIAL_EVERY`.

## Sorun giderme

- **"Model yüklenemedi" / libcublas hatası**: `install.sh` CUDA kütüphanelerini venv içine kurar; `server.py` bunları otomatik önyükler. Yine olmazsa `nvidia-smi` ile sürücüyü kontrol et.
- **Otomatik yazma çalışmıyor**: `ydotool` kurulu mu, `/dev/uinput` yazılabilir mi (`ls -l /dev/uinput`), kullanıcı `input` grubunda mı? Değilse `xdotool` (X11 uygulamaları) denenir.
- **Mikrofon izni**: tarayıcı adres çubuğundaki mikrofon simgesinden izin ver; `localhost` güvenli bağlam sayılır.
- **Tahtadan mikrofon erişimi**: sunucuya IP ile HTTP üzerinden bağlanınca tarayıcı mikrofonu vermeyebilir; HTTPS gerekir.
- **Gecikme yüksek**: GPU kullanıldığından emin ol (`/api/status` → `device`).

## Dosyalar

```

## Lisans

Bu depoya henüz açık kaynak lisansı eklenmemiştir. Lisans eklenene kadar kodun yeniden dağıtımı veya türev çalışmalar için hak verilmiş sayılmaz.
server.py              FastAPI + WebSocket + Whisper akışı + otomatik yazma
static/index.html      arayüz
static/app.js          mikrofon, WebSocket, arayüz mantığı
static/pcm-worklet.js  16 kHz'ye indirgeme ve paketleme
static/style.css       görünüm
install.sh / run.sh    kurulum ve başlatma
```
