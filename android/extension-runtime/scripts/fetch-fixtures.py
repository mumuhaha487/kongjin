"""Download official store samples locally for tests; do not redistribute them."""
import concurrent.futures, hashlib, json, pathlib, struct, urllib.request, zipfile, io, os

ROOT = pathlib.Path(__file__).resolve().parents[1] / "fixtures"
SAMPLES = {
    "dark-reader": "eimadpbcbfnmbkopoojfekhnkhdbieeh",
    "ublock-lite": "ddkjiahejlhfcafbddmgiahcphecmpfh",
    "json-formatter": "bcjindcccaagfpapjjmafapmmgkkhgoa",
    "google-translate": "aapbdbdomjkkjkaonfhkkikfgjllcleb",
    "tampermonkey": "dhdgffkkebhmkfjojejmpbldmpobfkfo",
    "immersive-translate": "bpoadfkcbjbfhfodiogcnhhhpibjhbnh",
    "return-dislike": "gebbhagfogifgggkldgodflihgfeippi",
}

def fetch(item):
    name, ext_id = item
    url = ("https://clients2.google.com/service/update2/crx?response=redirect&prodversion=150.0.0.0"
           "&acceptformat=crx3&x=id%3D" + ext_id + "%26installsource%3Dondemand%26uc")
    path = ROOT / (name + ".crx")
    try:
        if not path.exists():
            proxy = os.environ.get("KJ_FIXTURE_PROXY")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": proxy}) if proxy else urllib.request.ProxyHandler())
            data = opener.open(urllib.request.Request(url, headers={"User-Agent": "Chrome/150.0.0.0"}), timeout=90).read()
            if data[:4] != b"Cr24": raise ValueError("not a CRX")
            path.write_bytes(data)
        data = path.read_bytes()
        offset = 12 + struct.unpack_from("<I", data, 8)[0]
        archive = zipfile.ZipFile(io.BytesIO(data[offset:]))
        manifest = json.loads(archive.read("manifest.json"))
        # Test fixtures only. Production extraction is separately verified in Kotlin.
        output = ROOT / name
        output.mkdir(exist_ok=True)
        for entry in archive.infolist():
            dest = (output / entry.filename).resolve()
            if not dest.is_relative_to(output.resolve()): raise ValueError("unsafe fixture")
            if not entry.is_dir():
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(archive.read(entry))
        result = dict(name=name, id=ext_id, version=manifest.get("version"), manifestVersion=manifest.get("manifest_version"), bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), url=url)
    except Exception as error:
        result = dict(name=name, id=ext_id, error=str(error))
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result

if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(fetch, SAMPLES.items()))
    (ROOT / "provenance.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    if any("error" in result for result in results):
        raise SystemExit("Some official test samples could not be downloaded; retry after restoring connectivity.")
