# Flowcharts — Training Selection

GitHub renders these Mermaid diagrams automatically. PNG copies for the retrospective
document are in `docs/img/`.

## 1. Whole system: how the three groups connect

```mermaid
flowchart TB
    U([User]) --> T1

    subgraph TR[Training Selection]
        direction LR
        T1[Create / open project] --> T2[Import GeoTIFF]
        T2 --> T3[Create classes]
        T3 --> T4[Label points / lines / polygons]
        T4 --> T5[Export training set<br/>approved examples only]
        T6[Review correction requests] --> T4
    end

    subgraph ML[Model / Learning & Tools]
        direction LR
        M1[Load training set<br/>pandas dataframe] --> M2[Train random forest<br/>scikit-learn]
        M2 --> M3[Predict every pixel]
        M3 --> M4[Scores: confusion matrix,<br/>classification report]
    end

    subgraph VE[Verification]
        direction LR
        V1[List images to verify] --> V2[Compare prediction<br/>with original image]
        V2 --> V3{Mistake found?}
        V3 -- yes --> V4[Highlight area:<br/>add / remove points / relabel]
        V3 -- no --> V5[Mark image verified]
    end

    T5 -- training_set JSON / CSV --> M1
    M3 -- predictions + model version --> V1
    M4 --> V2
    V4 -- correction_request JSON --> T6
```

## 2. Training tool: user flow for this sprint

```mermaid
flowchart TD
    A([Open app]) --> B{Project exists?}
    B -- no --> C[Create project] --> D
    B -- yes --> D[Open project]
    D --> E[Click Open TIFF…]
    E --> F{.tif / .tiff?}
    F -- no --> F1[/Message: file not supported/] --> E
    F -- yes --> G[Upload to backend]
    G --> H{rasterio can read it?}
    H -- no --> H1[/Message: file could not be read/] --> E
    H -- yes --> I[Show image fitted to window<br/>+ size, bands, CRS]
    I --> J[Zoom / pan / choose display bands]
    J --> K{Class selected?}
    K -- no --> L[Create class: name + colour] --> K
    K -- yes --> M[Click a pixel]
    M --> N[Backend reads ORIGINAL<br/>band values at row, col]
    N --> O[Point drawn in class colour<br/>details shown]
    O --> P{Mistake?}
    P -- remove point --> Q[Remove] --> O
    P -- undo --> R[Undo last action] --> O
    P -- no --> S{More points?}
    S -- yes --> M
    S -- no --> T[Export training set JSON / CSV]
    T --> U([Send to Model group])
```

## 3. TIFF import and pixel lookup (frontend ↔ backend)

```mermaid
sequenceDiagram
    actor User
    participant UI as React UI
    participant API as Flask API
    participant R as rasterio
    participant FS as Disk

    User->>UI: choose file
    UI->>UI: check extension (.tif/.tiff)
    UI->>API: POST /projects/{pid}/images (file)
    API->>R: open file
    alt not a readable GeoTIFF
        R-->>API: error
        API-->>UI: 415 + clear message
        UI-->>User: show message
    else ok
        R-->>API: width, height, bands, CRS, transform
        API->>FS: save image + project JSON
        API-->>UI: image info
        UI->>API: GET /images/{iid}/preview.png?bands=1,2,3
        API->>R: read 3 bands (downsample if > 2048 px)
        API-->>UI: 8-bit PNG (display only)
        User->>UI: click on canvas
        UI->>UI: screen → row, col (floor)
        UI->>API: POST /projects/{pid}/points {row, col, class_id}
        API->>R: read 1×1 window from ORIGINAL file
        API->>FS: append point + undo history
        API-->>UI: point with band values, pixel_id, map x/y
    end
```

## 4. Correction loop (Verification → Training)

```mermaid
flowchart TB
    A[Verification reviewer<br/>finds a wrong prediction] --> B[Create correction_request<br/>location + original prediction<br/>+ model version + explanation]
    B --> C[POST to Training API]
    C --> D{Schema valid?}
    D -- no --> E[422: list of problems] --> B
    D -- yes --> F[Stored as status: open]
    F --> G[Training user reviews request]
    G --> H{Agree?}
    H -- yes --> I[Add / remove / relabel points] --> J[status: accepted]
    H -- no --> K[status: dismissed + reason]
    J --> L[Export new training set] --> M[Model retrains → new version]
```

## 5. Architecture

```mermaid
flowchart TB
    subgraph Browser
        UI[React app<br/>Project screen · Viewer canvas · Label tree<br/>Model tab · Verification mode]
    end
    subgraph Backend[Flask on 127.0.0.1:8000 - python run.py]
        API[app.py<br/>REST API + serves the built site]
        TS[tiff_service.py<br/>rasterio: info, preview, pixel values]
        ST[store.py<br/>projects, label tree, undo / redo]
        LP[label_processing.py<br/>points, lines, polygons to pixels<br/>training set JSON / CSV, schemas]
        ML[ml.py<br/>random forest: train, predict, suggest]
        VER[verification.py<br/>correction requests]
    end
    subgraph Storage[backend/data/project_id/]
        PRJ[(project.json)]
        IMG[(images/*.tif)]
        MOD[(models/*.joblib<br/>predictions/*.npz)]
    end
    UI -- /api --> API
    API --> TS --> IMG
    API --> ST --> PRJ
    API --> LP --> TS
    API --> ML --> MOD
    ML --> LP
    API --> VER --> ML
    LP -- training_set --> EXT1[Model group's own service]
    EXT2[Verification group's own service] -- correction_request --> API
```
