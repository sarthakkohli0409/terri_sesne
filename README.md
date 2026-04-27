# TerriSense

Pharma territory optimization tool. Uploads HCP data by ZIP, applies
weighted index scoring, and uses weight-aware K-Means clustering to
produce balanced sales territories.

---

## Repo Structure

```
/
├── Backend/
│   ├── main.py          # FastAPI app
│   ├── requirements.txt
│   ├── Dockerfile
│   └── us_zips.csv      # Master ZIP → lat/long (do not delete)
├── Frontend/
│   ├── src/
│   │   └── app/
│   │       ├── dashboard/page.tsx
│   │       ├── login/page.tsx
│   │       └── ...
│   ├── next.config.ts
│   └── .env.local       # local dev only, not committed
├── render.yaml          # Render Blueprint (deploys both services)
└── README.md
```

---

## Local Development

### Backend

```bash
cd Backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Visit `http://localhost:8000/health` to confirm it's running.

### Frontend

```bash
cd Frontend
npm install
# .env.local already points to localhost:8000
npm run dev
```

Visit `http://localhost:3000`.

---

## Deploying to Render via GitHub

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_ORG/terrisense.git
git push -u origin main
```

### Step 2 — Deploy Backend first

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Set:
   - **Root Directory:** `Backend`
   - **Runtime:** Docker
   - **Dockerfile path:** `./Dockerfile`
4. Set plan to **Standard** (KMeans jobs are CPU-heavy; free tier will time out)
5. Deploy and note the URL, e.g. `https://terrisense-backend.onrender.com`

### Step 3 — Deploy Frontend

1. **New → Web Service**
2. Connect same repo
3. Set:
   - **Root Directory:** `Frontend`
   - **Runtime:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
4. Add environment variable:
   - `NEXT_PUBLIC_API_URL` = `https://terrisense-backend.onrender.com`
5. Deploy

### Step 4 — Use render.yaml (alternative, one-click)

Instead of steps 2–3, use the **Blueprint** flow:
1. Render Dashboard → **New → Blueprint**
2. Connect repo — Render reads `render.yaml` automatically
3. Update `NEXT_PUBLIC_API_URL` in `render.yaml` with the backend URL before pushing

---

## Algorithm Notes

| Concern | Approach |
|---|---|
| Centroid placement | Weight-aware diagonal bucketing (not random) |
| KMeans fit | Non-zero ZIPs only, seeded centroids |
| Assignment order | Non-zero ZIPs first (guaranteed placement), zero-weight ZIPs fill gaps |
| Hard floor | 650 — no territory can go below this |
| Tolerance band | 1000 ± x% selected by user (5/10/15/20/25%) |
| Underweight territories | Dissolved into nearest viable neighbor; K preserved via local re-split |
| Optimal K | Surfaced from `total_weight / 1000`, feasible range from cap math |

---

## Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Frontend | Backend base URL |
| `PORT` | Both (Render injects) | Port to listen on |
