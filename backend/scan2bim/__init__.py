"""
Scan2BIM — von der Punktwolke zum georeferenzierten Bauwerksmodell.

    kern         Rechenstufen: rastern, Gelände, Flächen, Objekte
    netz         Geländenetz, regelmäßig oder adaptiv
    georef       Georeferenz aus dem Tileset der Quellwolke
    ausgabe_glb  GLB über trimesh — der Anblick
    ausgabe_ifc  IFC4 mit einem Bauteil je Objekt — die Struktur
    lauf         die Stufen in Reihenfolge, mit Fortschritt
    cli          Kommandozeile

Über HTTP: POST /assets/{job_id}/scan2bim (api/routes/scan2bim.py).
"""
