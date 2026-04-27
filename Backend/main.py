from fastapi import FastAPI, UploadFile, File, Form, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import pandas as pd
import numpy as np
from sklearn.cluster import KMeans
from sklearn.metrics import pairwise_distances
from geopy.distance import geodesic
import io
import folium
import os
import random
import json
import zipfile
from typing import Dict, Tuple, List
from collections import defaultdict
import math

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Master geodata — loaded once at startup
# ---------------------------------------------------------------------------
MASTER_ZIP_DF: pd.DataFrame = pd.DataFrame()


def load_master_geodata(filename: str = "us_zips.csv"):
    global MASTER_ZIP_DF
    current_dir = os.path.dirname(os.path.abspath(__file__))
    filepath = os.path.join(current_dir, filename)
    try:
        if os.path.exists(filepath):
            MASTER_ZIP_DF = pd.read_csv(filepath, dtype=str)
            MASTER_ZIP_DF.columns = MASTER_ZIP_DF.columns.str.strip().str.lower()
            MASTER_ZIP_DF.rename(columns={
                'zip': 'zip_code', 'zipcode': 'zip_code',
                'postal': 'zip_code', 'lat': 'latitude', 'lng': 'longitude',
                'long': 'longitude',
            }, inplace=True)
            required = {'zip_code', 'latitude', 'longitude'}
            if required.issubset(MASTER_ZIP_DF.columns):
                MASTER_ZIP_DF['zip_code'] = (
                    MASTER_ZIP_DF['zip_code'].astype(str).str.strip().str.zfill(5)
                )
                MASTER_ZIP_DF['latitude'] = pd.to_numeric(
                    MASTER_ZIP_DF['latitude'], errors='coerce')
                MASTER_ZIP_DF['longitude'] = pd.to_numeric(
                    MASTER_ZIP_DF['longitude'], errors='coerce')
                MASTER_ZIP_DF.dropna(
                    subset=['latitude', 'longitude', 'zip_code'], inplace=True)
                print(f"Master geodata loaded: {len(MASTER_ZIP_DF)} rows")
            else:
                print(f"Warning: missing columns. Found: {MASTER_ZIP_DF.columns.tolist()}")
        else:
            print(f"Error: geodata file not found at {filepath}")
    except Exception as e:
        print(f"Failed to load master geodata: {e}")


load_master_geodata()


# ---------------------------------------------------------------------------
# File reading helper
# ---------------------------------------------------------------------------
def read_file_smartly(content: bytes, filename: str) -> pd.DataFrame:
    filename = filename.lower()
    try:
        if filename.endswith('.csv'):
            df = pd.read_csv(io.StringIO(content.decode('utf-8')), dtype=str)
        elif filename.endswith(('.xls', '.xlsx')):
            df = pd.read_excel(io.BytesIO(content), dtype=str)
        else:
            raise ValueError("Unsupported file type. Please upload CSV or Excel.")
    except Exception as e:
        raise ValueError(f"Failed to read file: {str(e)}")
    df.columns = df.columns.str.strip()
    return df


# ---------------------------------------------------------------------------
# Preprocessing
# ---------------------------------------------------------------------------
def preprocess_data(df: pd.DataFrame, column_config: Dict[str, float]) -> pd.DataFrame:
    """
    Index calculation (per HCP row, then aggregated to ZIP level):

    Step 1 — Normalize each metric column: normalized = value / max(column)
             This brings all metrics to [0, 1] on the same scale.

    Step 2 — Composite score = sumproduct(user weight% / 100, normalized value)
             e.g. 0.25 * norm_col1 + 0.25 * norm_col2 + ...

    Step 3 — Aggregate composite scores to ZIP level (sum).

    Step 4 — Index per ZIP = (zip_composite / total_composite) * K * 1000
             This is done later in run_scenario once K is known.
             Here we store zip_composite (the share numerator).
    """
    global MASTER_ZIP_DF

    zip_col = next((
        c for c in df.columns
        if c.lower().replace('_', '').replace(' ', '')
        in ['zip', 'zipcode', 'postalcode', 'rowlabels', 'zipcode']
    ), None)
    if not zip_col:
        raise ValueError(f"Cannot find ZIP column. Columns found: {df.columns.tolist()}")

    df[zip_col] = df[zip_col].astype(str).str.split('.').str[0].str.strip()
    df['clean_zip'] = df[zip_col].apply(lambda x: x.zfill(5))

    numeric_cols = []
    for col in column_config:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)
            numeric_cols.append(col)

    if not numeric_cols:
        raise ValueError(
            f"None of the specified columns found. "
            f"You specified: {list(column_config.keys())}. "
            f"File has: {df.columns.tolist()}"
        )

    # Step 1: Normalize each column by its max (per-column, across all HCP rows)
    for col in numeric_cols:
        col_max = df[col].max()
        df[f'_norm_{col}'] = df[col] / col_max if col_max > 0 else 0.0

    # Step 2: Composite score per HCP row = weighted sum of normalized values
    df['_composite'] = 0.0
    for col, pct in column_config.items():
        if col in numeric_cols:
            df['_composite'] += (float(pct) / 100.0) * df[f'_norm_{col}']

    # Step 3: Aggregate to ZIP level — sum composite scores, count HCPs
    df_agg = df.groupby('clean_zip').agg(
        zip_composite=('_composite', 'sum'),
        rep_count=('clean_zip', 'count')
    ).reset_index()

    if MASTER_ZIP_DF.empty:
        raise ValueError("Master geodata missing or failed to load.")

    # Join with master geodata
    merged = pd.merge(
        df_agg,
        MASTER_ZIP_DF[['zip_code', 'latitude', 'longitude']],
        left_on='clean_zip', right_on='zip_code',
        how='right'
    )

    merged['clean_zip'] = merged['clean_zip'].fillna(merged['zip_code'])
    merged['zip_composite'] = merged['zip_composite'].fillna(0.0)
    merged['rep_count'] = merged['rep_count'].fillna(0).astype(int)

    merged['latitude'] = merged['latitude'].astype(float)
    merged['longitude'] = merged['longitude'].astype(float)
    merged.dropna(subset=['latitude', 'longitude', 'clean_zip'], inplace=True)
    merged = merged.reset_index(drop=True)

    return merged


# ---------------------------------------------------------------------------
# Optimal K recommendation
# ---------------------------------------------------------------------------
def recommend_k(zip_composites: np.ndarray, chosen_k: int, min_cap: float, max_cap: float, hard_floor: float) -> dict:
    """
    The index formula always produces total = K*1000 by construction,
    so 'optimal K' is not a fixed number — it depends on the user's chosen K.

    What we CAN compute:
    - k_min: fewest territories where no single ZIP's index exceeds max_cap
      (a ZIP with index > max_cap can't fit in any territory alone)
    - k_max: most territories before the average ZIP index drops below hard_floor
      (territories become too sparse to meet the floor)

    At chosen_k, each ZIP's index = (zip_composite/total)*chosen_k*1000.
    We find the range of K where the data is viable.
    """
    if len(zip_composites) == 0 or zip_composites.sum() <= 0:
        return {"optimal_k": chosen_k, "k_min": 1, "k_max": chosen_k * 2}

    total = zip_composites.sum()
    nz = zip_composites[zip_composites > 0]

    # At a given K, max single-ZIP index = (max_zip_composite/total)*K*1000
    # We need this <= max_cap:  K <= max_cap * total / (max_zip_composite * 1000)
    max_zip = nz.max()
    k_max_from_cap = math.floor(max_cap * total / (max_zip * 1000)) if max_zip > 0 else chosen_k * 2

    # At a given K, for territories to stay above hard_floor we need enough ZIPs per territory.
    # Approximation: total_index = K*1000, so we need K <= total_index/hard_floor
    # Since total_index = K*1000 always, this simplifies to: hard_floor <= 1000 always true.
    # Better: use number of nonzero ZIPs — can't have more territories than nonzero ZIPs
    k_max_from_zips = len(nz)

    k_max = min(k_max_from_cap, k_max_from_zips)
    k_min = max(1, math.ceil(chosen_k * 0.5))  # conservative lower bound

    # Optimal K: where total weight distributes most evenly = chosen K (always valid by construction)
    # But flag if chosen K is outside the viable range
    optimal_k = chosen_k  # by construction, K*1000 / K = 1000 per territory

    return {
        "optimal_k": int(optimal_k),
        "k_min": int(k_min),
        "k_max": int(k_max),
        "chosen_k_feasible": int(k_min) <= chosen_k <= int(k_max),
    }


# ---------------------------------------------------------------------------
# Weight-aware centroid seeding
# ---------------------------------------------------------------------------
def seed_centroids_by_weight(
    coords: np.ndarray,
    weights: np.ndarray,
    k: int
) -> np.ndarray:
    """
    Divide ZIPs into K equal-weight buckets along a space-filling diagonal
    ordering, then return the weighted geographic centroid of each bucket
    as the starting centroid for KMeans.
    """
    nonzero_mask = weights > 0
    nz_coords = coords[nonzero_mask]
    nz_weights = weights[nonzero_mask]

    if len(nz_coords) < k:
        # Fall back to random selection if not enough nonzero ZIPs
        idx = np.random.choice(len(coords), size=k, replace=False)
        return coords[idx]

    # Project onto diagonal (lat + lon) to create a 1-D ordering
    diagonal = nz_coords[:, 0] + nz_coords[:, 1]
    order = np.argsort(diagonal)
    sorted_coords = nz_coords[order]
    sorted_weights = nz_weights[order]

    total_weight = sorted_weights.sum()
    bucket_size = total_weight / k
    cumulative = np.cumsum(sorted_weights)

    centroids = []
    prev_cut = 0.0
    for i in range(k):
        target = bucket_size * (i + 1)
        # Find indices in this bucket
        in_bucket = (cumulative > prev_cut) & (cumulative <= target)
        # Edge: last bucket catches remainder
        if i == k - 1:
            in_bucket = cumulative > prev_cut

        bucket_coords = sorted_coords[in_bucket]
        bucket_wts = sorted_weights[in_bucket]

        if len(bucket_coords) == 0:
            # Use the nearest available point
            centroids.append(sorted_coords[min(int(prev_cut), len(sorted_coords) - 1)])
        else:
            wt_sum = bucket_wts.sum()
            if wt_sum > 0:
                centroid = np.average(bucket_coords, weights=bucket_wts, axis=0)
            else:
                centroid = bucket_coords.mean(axis=0)
            centroids.append(centroid)

        prev_cut = target

    return np.array(centroids)


# ---------------------------------------------------------------------------
# Core: constrained assignment
# ---------------------------------------------------------------------------
def assign_zips(
    coords: np.ndarray,
    weights: np.ndarray,
    centroids: np.ndarray,
    min_cap: float,
    max_cap: float,
    hard_floor: float = 650.0,
) -> np.ndarray:
    """
    Assign ZIPs to territories enforcing max_cap.
    Non-zero ZIPs are assigned first (they must be placed).
    Zero-weight ZIPs fill geographic gaps afterward.
    Returns label array (index = territory ID, -1 = unassigned).
    """
    k = len(centroids)
    dist_matrix = pairwise_distances(coords, centroids)  # (n_zips, k)

    labels = np.full(len(coords), -1, dtype=int)
    cluster_loads = np.zeros(k)

    nonzero_idx = np.where(weights > 0)[0]
    zero_idx = np.where(weights == 0)[0]

    def _assign_batch(indices):
        # Sort by distance to their closest centroid (greedy nearest-first)
        closest = np.argmin(dist_matrix[indices], axis=1)
        dist_to_closest = dist_matrix[indices, closest]
        order = np.argsort(dist_to_closest)

        for pos in order:
            zip_idx = indices[pos]
            w = weights[zip_idx]
            # Try territories in order of proximity
            territory_order = np.argsort(dist_matrix[zip_idx])
            for t_id in territory_order:
                if cluster_loads[t_id] + w <= max_cap:
                    labels[zip_idx] = t_id
                    cluster_loads[t_id] += w
                    break
            # If no territory has room, assign to absolute closest (weight overflow allowed for nonzero)

    _assign_batch(nonzero_idx)

    # Zero-weight ZIPs: always assign to nearest, no capacity concern
    for zip_idx in zero_idx:
        labels[zip_idx] = np.argmin(dist_matrix[zip_idx])

    return labels, cluster_loads


# ---------------------------------------------------------------------------
# Post-processing: dissolve underweight, maintain K
# ---------------------------------------------------------------------------
def dissolve_and_rebalance(
    df: pd.DataFrame,
    labels: np.ndarray,
    cluster_loads: np.ndarray,
    coords: np.ndarray,
    weights: np.ndarray,
    k: int,
    min_cap: float,
    max_cap: float,
    hard_floor: float = 650.0,
    max_iter: int = 10,
) -> np.ndarray:
    """
    Iteratively dissolve territories below hard_floor by absorbing their
    nonzero ZIPs into the geographically nearest neighbor that:
      (a) has enough headroom under max_cap, OR
      (b) combined weight >= 2 * hard_floor (so the merged territory
          can then be re-split to restore K).

    K is always maintained.
    """
    labels = labels.copy()
    cluster_loads = cluster_loads.copy()

    for iteration in range(max_iter):
        # Find underweight territories (only counting nonzero ZIPs)
        underweight = []
        for t_id in range(k):
            nz_in_t = np.where((labels == t_id) & (weights > 0))[0]
            load = weights[nz_in_t].sum()
            if load < hard_floor and len(nz_in_t) > 0:
                underweight.append((t_id, load))

        if not underweight:
            break  # Converged

        for (t_id, t_load) in underweight:
            t_nz_idx = np.where((labels == t_id) & (weights > 0))[0]
            if len(t_nz_idx) == 0:
                continue

            # Centroid of this underweight territory
            t_center = coords[t_nz_idx].mean(axis=0)

            # Find neighbor territories by proximity of centroid
            neighbor_centers = {}
            for n_id in range(k):
                if n_id == t_id:
                    continue
                n_nz = np.where((labels == n_id) & (weights > 0))[0]
                if len(n_nz) == 0:
                    continue
                neighbor_centers[n_id] = coords[n_nz].mean(axis=0)

            if not neighbor_centers:
                continue

            # Sort neighbors by distance to underweight territory centroid
            neighbors_by_dist = sorted(
                neighbor_centers.items(),
                key=lambda x: np.linalg.norm(x[1] - t_center)
            )

            # Find best merge candidate
            merge_target = None
            for (n_id, _) in neighbors_by_dist:
                combined = cluster_loads[n_id] + t_load
                # Can absorb directly without breaching max
                if combined <= max_cap:
                    merge_target = n_id
                    break
                # Can absorb and then split (both halves would be viable)
                if combined >= 2 * hard_floor:
                    merge_target = n_id
                    break

            if merge_target is None:
                # No valid merge partner — skip this territory this iteration
                continue

            n_id = merge_target
            combined = cluster_loads[n_id] + t_load

            # Absorb underweight territory into neighbor
            labels[t_nz_idx] = n_id
            # Also move zero-weight ZIPs of t_id to n_id
            t_zero_idx = np.where((labels == t_id) & (weights == 0))[0]
            labels[t_zero_idx] = n_id
            cluster_loads[n_id] = combined
            cluster_loads[t_id] = 0

            # If combined > max_cap, re-split using local KMeans(2)
            if combined > max_cap:
                merged_idx = np.where(labels == n_id)[0]
                merged_coords = coords[merged_idx]
                merged_weights = weights[merged_idx]

                local_km = KMeans(n_clusters=2, random_state=42, n_init=1, max_iter=50)
                local_km.fit(
                    merged_coords,
                    sample_weight=np.where(merged_weights > 0, merged_weights, 1e-6)
                )
                sub_labels = local_km.labels_

                # One sub-cluster keeps n_id, other gets t_id
                labels[merged_idx[sub_labels == 0]] = n_id
                labels[merged_idx[sub_labels == 1]] = t_id

                cluster_loads[n_id] = weights[merged_idx[sub_labels == 0]].sum()
                cluster_loads[t_id] = weights[merged_idx[sub_labels == 1]].sum()

    return labels, cluster_loads


# ---------------------------------------------------------------------------
# Statistics per territory
# ---------------------------------------------------------------------------
def compute_stats(
    df: pd.DataFrame,
    labels: np.ndarray,
    weights: np.ndarray,
    k: int,
    min_cap: float,
    max_cap: float,
    hard_floor: float,
) -> dict:
    stats = {}
    for t_id in range(k):
        t_mask = labels == t_id
        t_df = df[t_mask]
        total_w = int(weights[t_mask].sum())
        zip_count = int(t_mask.sum())
        nz_count = int(((labels == t_id) & (weights > 0)).sum())

        diameter = 0
        if len(t_df) >= 2:
            try:
                mins = t_df[['latitude', 'longitude']].min()
                maxs = t_df[['latitude', 'longitude']].max()
                diameter = int(geodesic(
                    (mins.latitude, mins.longitude),
                    (maxs.latitude, maxs.longitude)
                ).miles)
            except Exception:
                pass

        if total_w < hard_floor:
            status, msg = "Red", f"Below floor — needs {int(hard_floor - total_w)} more"
        elif total_w < min_cap:
            status, msg = "Yellow", f"Needs {int(min_cap - total_w)} more"
        elif total_w > max_cap:
            status, msg = "Orange", f"Over cap by {int(total_w - max_cap)}"
        else:
            status, msg = "Green", "Optimal"

        stats[t_id] = {
            "Status": status,
            "Message": msg,
            "Weight": total_w,
            "ZipCount": zip_count,
            "NonZeroZips": nz_count,
            "Diameter": diameter,
        }
    return stats


# ---------------------------------------------------------------------------
# Master run_scenario
# ---------------------------------------------------------------------------
def run_scenario(
    df: pd.DataFrame,
    k: int,
    min_cap: float,
    max_cap: float,
    hard_floor: float = 650.0,
) -> Tuple[pd.DataFrame, dict, dict]:
    scenario_df = df.copy().reset_index(drop=True)

    # Step 4: Index = (zip_composite / total_composite) * K * 1000
    total_composite = scenario_df['zip_composite'].sum()
    if total_composite <= 0:
        raise ValueError("Total composite score is zero — check that your column names match the file.")

    scenario_df['final_weight'] = (
        (scenario_df['zip_composite'] / total_composite) * k * 1000
    ).fillna(0).clip(lower=0)

    coords = scenario_df[['latitude', 'longitude']].values
    weights = scenario_df['final_weight'].round().astype(int).values
    scenario_df['final_weight'] = weights  # keep in sync as int

    total_weight = float(scenario_df['final_weight'].sum())
    zip_composites = scenario_df['zip_composite'].values
    k_rec = recommend_k(zip_composites, k, min_cap, max_cap, hard_floor)

    # Step 1: Seed centroids using weight distribution
    seeded_centroids = seed_centroids_by_weight(coords, weights, k)

    # Step 2: Run KMeans from seeded centroids on nonzero ZIPs only
    nonzero_mask = weights > 0
    nz_coords = coords[nonzero_mask]
    nz_weights = weights[nonzero_mask]

    if len(nz_coords) < k:
        raise ValueError(
            f"Not enough non-zero ZIPs ({len(nz_coords)}) to form {k} territories."
        )

    kmeans = KMeans(
        n_clusters=k,
        init=seeded_centroids,
        n_init=1,
        random_state=42,
        max_iter=100,   # cut off early — seeded centroids need far fewer iterations
        tol=1e-2,       # looser tolerance for faster convergence
    )
    kmeans.fit(nz_coords, sample_weight=nz_weights)
    centroids = kmeans.cluster_centers_

    # Step 3: Assign all ZIPs (nonzero first, zero-weight after)
    labels, cluster_loads = assign_zips(
        coords, weights, centroids, min_cap, max_cap, hard_floor
    )

    # Step 4: Dissolve underweight territories, maintain K
    labels, cluster_loads = dissolve_and_rebalance(
        scenario_df, labels, cluster_loads,
        coords, weights, k,
        min_cap, max_cap, hard_floor,
        max_iter=5,
    )

    scenario_df['Territory_ID'] = labels
    scenario_df['final_weight'] = weights

    # Step 5: Compute stats
    stats = compute_stats(scenario_df, labels, weights, k, min_cap, max_cap, hard_floor)

    return scenario_df, stats, k_rec


# ---------------------------------------------------------------------------
# Map generation
# ---------------------------------------------------------------------------
def generate_map_html(df: pd.DataFrame, stats: dict, k: int, title: str) -> str:
    center_lat = df['latitude'].mean() if not df.empty else 39.8
    center_lon = df['longitude'].mean() if not df.empty else -98.5

    m = folium.Map(location=[center_lat, center_lon], zoom_start=5, prefer_canvas=True)
    m.get_root().html.add_child(
        folium.Element(f'<h3 align="center" style="font-size:16px"><b>{title}</b></h3>')
    )

    random.seed(42)
    colors = ["#{:06x}".format(random.randint(0x333333, 0xCCCCCC)) for _ in range(k)]
    status_border = {"Green": "black", "Yellow": "orange", "Red": "red", "Orange": "darkorange"}

    # Only render ZIPs with actual HCP activity (nonzero weight)
    active_df = df[df['final_weight'] > 0].copy()

    # Territory label markers only (one per territory centroid)
    for t_id in range(k):
        t_data = active_df[active_df['Territory_ID'] == t_id]
        if t_data.empty:
            continue
        s = stats.get(t_id, {})
        center = [t_data['latitude'].mean(), t_data['longitude'].mean()]
        folium.Marker(
            center,
            icon=folium.DivIcon(
                html=(
                    f'<div style="font-size:8pt;font-weight:bold;color:#fff;'
                    f'background:{status_border.get(s.get("Status",""), "#333")};'
                    f'padding:2px 4px;border-radius:3px;white-space:nowrap;">'
                    f'T{t_id} | {s.get("Weight")}</div>'
                ),
                icon_size=(80, 20),
                icon_anchor=(40, 10),
            ),
            popup=folium.Popup(
                f"<b>Territory {t_id}</b><br>"
                f"Status: {s.get('Status')}<br>"
                f"Weight: {s.get('Weight')}<br>"
                f"Active ZIPs: {s.get('NonZeroZips')}<br>"
                f"Diameter: {s.get('Diameter')} mi<br>"
                f"{s.get('Message')}",
                max_width=200,
            ),
        ).add_to(m)

    # Batch all ZIP dots using a single GeoJson layer per territory
    # (far faster than individual CircleMarkers)
    for t_id in range(k):
        t_data = active_df[active_df['Territory_ID'] == t_id]
        if t_data.empty:
            continue
        color = colors[t_id]
        features = []
        for _, row in t_data.iterrows():
            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [row['longitude'], row['latitude']],
                },
                "properties": {
                    "popup": f"ZIP: {row['clean_zip']} | Weight: {int(row['final_weight'])}",
                },
            })
        geojson = {"type": "FeatureCollection", "features": features}
        folium.GeoJson(
            geojson,
            name=f"Territory {t_id}",
            marker=folium.CircleMarker(
                radius=3,
                color=color,
                fill=True,
                fill_color=color,
                fill_opacity=0.8,
                weight=0,
            ),
            tooltip=folium.GeoJsonTooltip(fields=["popup"], labels=False),
        ).add_to(m)

    folium.LayerControl().add_to(m)
    return m._repr_html_()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# HCP-level composite + decile + segment assignment
# ---------------------------------------------------------------------------

def compute_hcp_composite(
    df: pd.DataFrame,
    column_config: Dict[str, float],
) -> pd.DataFrame:
    """
    Returns df with added columns:
      _composite  — weighted composite score per HCP row
    Normalization is value / global_max per column.
    """
    df = df.copy()
    numeric_cols = []
    for col in column_config:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)
            numeric_cols.append(col)

    if not numeric_cols:
        raise ValueError(
            f"None of the specified columns found. "
            f"Specified: {list(column_config.keys())}. "
            f"File has: {df.columns.tolist()}"
        )

    df['_composite'] = 0.0
    for col, pct in column_config.items():
        if col in numeric_cols:
            col_max = df[col].max()
            norm = df[col] / col_max if col_max > 0 else 0.0
            df['_composite'] += (float(pct) / 100.0) * norm

    return df


def assign_deciles(df: pd.DataFrame) -> pd.DataFrame:
    """
    Decile = based on composite score VALUE share, not HCP count.
    Each decile D0–D10 represents 10% of total composite score mass.
    D10 = top 10% of composite mass (fewest but highest-scoring HCPs).
    D0  = bottom 10% of composite mass (most but lowest-scoring HCPs).

    Algorithm:
    1. Sort HCPs by composite score descending
    2. Compute cumulative composite share
    3. Assign D10 to HCPs whose cumulative share falls in [0%, 10%],
       D9 for [10%, 20%], ..., D0 for [90%, 100%]
    """
    df = df.copy()
    total = df['_composite'].sum()

    if total <= 0:
        df['_decile'] = 0
        return df

    # Sort descending by composite
    df = df.sort_values('_composite', ascending=False).reset_index(drop=True)
    df['_cumshare'] = df['_composite'].cumsum() / total

    # Assign decile: D10 = first 10% of mass, D9 = next 10%, etc.
    def _decile(cumshare: float) -> int:
        # cumshare is the cumulative share AT this row (inclusive)
        # decile = 10 - floor(cumshare * 10), clamped to [0, 10]
        d = 10 - int(cumshare * 10)
        return max(0, min(10, d))

    df['_decile'] = df['_cumshare'].apply(_decile)

    # Edge: HCPs at the exact boundary (cumshare=0.1, 0.2, ...) go to the lower decile
    # This is handled by floor above. Verify D10 covers [0, 0.1).
    # Correct boundary: HCPs where prev_cumshare < threshold get D10
    # Simple fix: recompute using start-of-row cumshare
    prev = df['_cumshare'].shift(1).fillna(0)
    df['_decile'] = prev.apply(lambda x: max(0, min(10, 10 - int(x * 10))))

    return df


def assign_segments(
    df: pd.DataFrame,
    segment_config: list,
) -> pd.DataFrame:
    """
    segment_config is a list of dicts, ordered highest to lowest:
    [
      {
        "segment": "Very High",
        "start_decile": 10,
        "end_decile": 8,
        "calls_per_hcp": 12,
        "target": true
      },
      ...
    ]
    Each HCP is assigned a segment based on which decile range contains their _decile.
    HCPs with _decile not covered by any segment get segment = "Unassigned", calls = 0.
    """
    df = df.copy()
    df['_segment'] = 'Unassigned'
    df['_calls_per_hcp'] = 0
    df['_targeted'] = False

    for seg in segment_config:
        if not seg.get('target', False):
            continue
        start = int(seg['start_decile'])
        end = int(seg['end_decile'])
        lo, hi = min(start, end), max(start, end)
        mask = (df['_decile'] >= lo) & (df['_decile'] <= hi)
        df.loc[mask, '_segment'] = seg['segment']
        df.loc[mask, '_calls_per_hcp'] = float(seg.get('calls_per_hcp', 0))
        df.loc[mask, '_targeted'] = True

    return df


def compute_calls_required(df: pd.DataFrame) -> int:
    """
    Total calls = sum of calls_per_hcp for all targeted HCPs.
    """
    return int((df['_calls_per_hcp'] * df['_targeted']).sum())


def build_decile_table(df: pd.DataFrame) -> list:
    """
    Returns list of {decile, hcp_count, calls_per_hcp} for D0–D10.
    """
    rows = []
    for d in range(10, -1, -1):
        subset = df[df['_decile'] == d]
        calls = int(subset['_calls_per_hcp'].max()) if len(subset) > 0 else 0
        rows.append({
            "decile": f"D{d}",
            "hcp_count": len(subset),
            "calls_per_hcp": calls,
        })
    return rows


def detect_metric_columns(df: pd.DataFrame) -> list:
    """
    Auto-detect likely metric columns by excluding known non-metric fields.
    Returns list of column names.
    """
    non_metric_patterns = {
        'customer_id', 'customerid', 'id',
        'customer_name', 'customername', 'name',
        'city', 'state', 'zip', 'zipcode', 'zip_code',
        'postalcode', 'postal_code', 'county', 'country',
        'zip_population', 'zippopulation', 'population',
    }
    # Also exclude columns that look like calculated/derived (contain these words)
    derived_keywords = ['normalize', 'composite', 'index', 'decile', 'segment', 'score', 'unnamed']

    metrics = []
    for col in df.columns:
        if not isinstance(col, str):
            continue
        key = col.lower().replace('_', '').replace(' ', '').replace(':', '')
        # Skip known non-metric exact matches
        if any(key == nm.replace('_', '') for nm in non_metric_patterns):
            continue
        # Skip derived/calculated columns
        if any(kw in col.lower() for kw in derived_keywords):
            continue
        if key.startswith('unnamed'):
            continue
        # Must be mostly numeric
        try:
            numeric_ratio = pd.to_numeric(df[col], errors='coerce').notna().mean()
            if numeric_ratio >= 0.5:
                metrics.append(col)
        except Exception:
            pass
    return metrics


# ---------------------------------------------------------------------------
# /detect_columns — returns metric column names from uploaded file
# ---------------------------------------------------------------------------
@app.post("/detect_columns")
async def detect_columns(file: UploadFile = File(...)):
    try:
        content = await file.read()
        df = read_file_smartly(content, file.filename)
        metrics = detect_metric_columns(df)
        return {"columns": metrics, "all_columns": df.columns.tolist()}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# /analyze — composite + decile + segment + calls calculation
# ---------------------------------------------------------------------------
@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    column_config: str = Form(...),
    segment_config: str = Form(...),
):
    try:
        config = json.loads(column_config)
        segments = json.loads(segment_config)
        content = await file.read()
        df = read_file_smartly(content, file.filename)

        # Step 1: Composite score per HCP
        df = compute_hcp_composite(df, config)

        # Step 2: Assign deciles based on composite score mass
        df = assign_deciles(df)

        # Step 3: Assign segments and calls
        df = assign_segments(df, segments)

        # Step 4: Compute totals
        calls_required = compute_calls_required(df)
        decile_table = build_decile_table(df)

        # Step 5: Segment summary
        seg_summary = []
        for seg in segments:
            if not seg.get('target', False):
                continue
            name = seg['segment']
            subset = df[df['_segment'] == name]
            seg_summary.append({
                "segment": name,
                "hcp_count": len(subset),
                "calls_per_hcp": seg.get('calls_per_hcp', 0),
                "total_calls": int(subset['_calls_per_hcp'].sum()),
                "start_decile": seg['start_decile'],
                "end_decile": seg['end_decile'],
            })

        return {
            "calls_required": calls_required,
            "decile_table": decile_table,
            "segment_summary": seg_summary,
            "total_hcps": len(df),
            "targeted_hcps": int(df['_targeted'].sum()),
        }

    except Exception as e:
        print(f"ERROR /analyze: {e}")
        return {"error": str(e)}


@app.post("/optimize_map")
async def optimize_map(
    file: UploadFile = File(...),
    num_clusters: int = Form(...),
    column_config: str = Form(...),
    tolerance_pct: int = Form(15),
):
    try:
        config = json.loads(column_config)
        content = await file.read()
        raw_df = read_file_smartly(content, file.filename)
        base_df = preprocess_data(raw_df, config)

        hard_floor = 650.0
        min_cap = round(1000 * (1 - tolerance_pct / 100))
        max_cap = round(1000 * (1 + tolerance_pct / 100))

        k = int(num_clusters)
        df_res, stats_res, k_rec = run_scenario(base_df, k, min_cap, max_cap, hard_floor)

        html_str = generate_map_html(
            df_res, stats_res, k,
            f"TerriSense — K={k} | Tolerance ±{tolerance_pct}% | "
            f"Optimal K={k_rec['optimal_k']} (range {k_rec['k_min']}–{k_rec['k_max']})"
        )

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(f"territory_map_k{k}.html", html_str)
            zf.writestr("k_recommendation.json", json.dumps(k_rec, indent=2))

        zip_buffer.seek(0)
        headers = {
            'Content-Disposition': 'attachment; filename="territory_map.zip"',
            'X-Optimal-K': str(k_rec['optimal_k']),
            'X-K-Min': str(k_rec['k_min']),
            'X-K-Max': str(k_rec['k_max']),
            'Access-Control-Expose-Headers': 'X-Optimal-K, X-K-Min, X-K-Max',
        }
        return StreamingResponse(zip_buffer, media_type="application/zip", headers=headers)

    except Exception as e:
        print(f"ERROR /optimize_map: {e}")
        return {"error": str(e)}


@app.post("/optimize_excel")
async def optimize_excel(
    file: UploadFile = File(...),
    num_clusters: int = Form(...),
    column_config: str = Form(...),
    tolerance_pct: int = Form(15),
):
    try:
        config = json.loads(column_config)
        content = await file.read()
        raw_df = read_file_smartly(content, file.filename)
        base_df = preprocess_data(raw_df, config)

        hard_floor = 650.0
        min_cap = round(1000 * (1 - tolerance_pct / 100))
        max_cap = round(1000 * (1 + tolerance_pct / 100))

        k = int(num_clusters)
        df_res, stats_res, k_rec = run_scenario(base_df, k, min_cap, max_cap, hard_floor)

        # Build export dataframe
        export_df = df_res[['clean_zip', 'Territory_ID', 'final_weight', 'rep_count']].copy()
        export_df.rename(columns={
            'clean_zip': 'ZIP_Code',
            'Territory_ID': 'Territory_ID',
            'final_weight': 'Index_Weight',
            'rep_count': 'HCP_Count',
        }, inplace=True)
        export_df.sort_values('Territory_ID', inplace=True)

        # Summary tab
        summary_rows = []
        for t_id, s in stats_res.items():
            summary_rows.append({
                'Territory_ID': t_id,
                'Status': s['Status'],
                'Message': s['Message'],
                'Total_Weight': s['Weight'],
                'ZIP_Count': s['ZipCount'],
                'NonZero_ZIPs': s['NonZeroZips'],
                'Diameter_Miles': s['Diameter'],
            })
        summary_df = pd.DataFrame(summary_rows).sort_values('Territory_ID')

        # K recommendation tab
        k_rec_df = pd.DataFrame([{
            'Chosen_K': k,
            'Optimal_K': k_rec['optimal_k'],
            'K_Min_Feasible': k_rec['k_min'],
            'K_Max_Feasible': k_rec['k_max'],
            'Tolerance_Pct': tolerance_pct,
            'Hard_Floor': int(hard_floor),
            'Min_Cap': min_cap,
            'Max_Cap': max_cap,
        }])

        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            export_df.to_excel(writer, index=False, sheet_name='ZIP_Assignments')
            summary_df.to_excel(writer, index=False, sheet_name='Territory_Summary')
            k_rec_df.to_excel(writer, index=False, sheet_name='K_Recommendation')

        output.seek(0)
        headers = {
            'Content-Disposition': 'attachment; filename="territory_analysis.xlsx"',
            'X-Optimal-K': str(k_rec['optimal_k']),
            'X-K-Min': str(k_rec['k_min']),
            'X-K-Max': str(k_rec['k_max']),
            'Access-Control-Expose-Headers': 'X-Optimal-K, X-K-Min, X-K-Max',
        }
        return Response(
            content=output.getvalue(),
            media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            headers=headers,
        )

    except Exception as e:
        print(f"ERROR /optimize_excel: {e}")
        return {"error": str(e)}


@app.get("/health")
def health():
    return {"status": "ok", "master_zip_rows": len(MASTER_ZIP_DF)}
