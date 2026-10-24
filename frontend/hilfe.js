/**
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * iLEEN — Handbuch
 *
 * Seit `hinweise.js` stehen die Erklärtexte nicht mehr zwischen den
 * Bedienelementen, sondern erscheinen beim Überfahren. Das beantwortet die
 * Frage „was macht dieser Schalter?" — nicht die Frage „was kann das
 * Programm?". Diese beantwortet das Handbuch.
 *
 * Aufgeschlagen wird es aus dem Bereich **Info** der linken Leiste oder über
 * `ILeenHilfe.oeffnen()`; mit einer Kapitelkennung springt es direkt dorthin:
 *
 *     ILeenHilfe.oeffnen('tragwerk');
 *
 * Der Inhalt steht als Daten in `KAPITEL`, nicht als HTML-Block. Die
 * Kapitelnavigation, die Suche und der Druckbogen entstehen daraus — ein
 * neues Werkzeug braucht deshalb einen Eintrag und sonst nichts.
 */
'use strict';

const ILeenHilfe = (() => {

  // ──────────────────────────────────────────────────────────────────────────
  // Inhalt
  //
  // `wo` sagt, an welcher Stelle der Oberfläche das Werkzeug liegt. Die
  // Trennung ist dieselbe wie im Programm: **links** in der Aktivitätsleiste
  // steht der Viewer, **rechts** im Analysepanel stehen die Auswertungen.
  //
  // `braucht` sagt, ob es das Werkzeug in dieser Fassung gibt. Das Handbuch
  // ist in der Vollfassung und in iLEEN-view dieselbe Datei; ein Eintrag mit
  // `braucht` erscheint nur, wenn sein Werkzeug geladen ist, und ein Kapitel,
  // dem dadurch kein Eintrag bleibt, fällt samt Navigation weg. So beschreibt
  // das Handbuch das Programm, das man vor sich hat. `lead` darf aus demselben
  // Grund eine Funktion sein. Ausgewertet wird beim ersten Aufschlagen — dann
  // sind alle Skripte gelaufen.
  // ──────────────────────────────────────────────────────────────────────────

  // `typeof` am blossen Namen und nicht `window.X`: manche Module legen ihren
  // Namen als `const` im Skriptbereich an, und der steht nicht auf `window`
  // (`RightPanel`, `RoomConceptPanel`, `IFClashPanel`).
  const reiter = (id) => typeof RightPanel !== 'undefined' && RightPanel.reiterListe.includes(id);
  const rechtsBelegt = () => typeof RightPanel !== 'undefined' && RightPanel.reiterListe.length > 0;
  const amViewer = (name) => !!(window.BimViewer && window.BimViewer[name]);
  const raeume = () => typeof RoomConceptPanel !== 'undefined';
  const kollisionen = () => typeof IFClashPanel !== 'undefined';

  const KAPITEL = [

    {
      id: 'start', symbol: '🧭', titel: 'Aufbau der Oberfläche',
      lead: () => rechtsBelegt()
        ? 'Zwei Seiten, eine Szene: links wird gezeigt und gemessen, rechts wird gerechnet und berichtet.'
        : 'Eine Szene, und links alles, was man mit ihr tut: laden, ansehen, messen, markieren.',
      eintraege: [
        {
          titel: 'Linke Leiste — der Viewer',
          wo: 'Aktivitätsleiste',
          text: `<p>Die schmale Symbolleiste am linken Rand öffnet die Bereiche
            <strong>Modelle</strong>, <strong>Ansicht</strong>, <strong>Bauteile</strong>,
            <strong>Werkzeuge</strong>, <strong>Notizen</strong>, <strong>Einstellungen</strong>
            und <strong>Info</strong>. Ein zweiter Klick auf dasselbe Symbol klappt das Panel wieder zu,
            <kbd>M</kbd> fährt die ganze Leiste ein.</p>
            <p>Kein Bereich ist fest verdrahtet: Werkzeuge melden sich selbst an. Deshalb
            erscheinen je nach geladenen Modulen zusätzliche Symbole, etwa <strong>📈</strong> für
            die Sensoren — ein solcher Knopf schaltet ein Panel über der Szene, statt die Leiste
            aufzuklappen.</p>`
        },
        {
          titel: 'Rechtes Analysepanel — die Auswertungen',
          wo: 'Reiterleiste rechts',
          braucht: rechtsBelegt,
          text: `<p>Am rechten Rand liegt je ein Reiter für <strong>Lastabtrag</strong>,
            <strong>Bauteil räumlich</strong>, <strong>StaLite</strong>, <strong>GEG</strong>,
            <strong>Solar</strong>, <strong>Themen &amp; BCF</strong>,
            <strong>BIM-Leistungsphasen</strong> und <strong>Bericht</strong>. Jeder Reiter bringt
            seine eigene Breite mit und lässt die Szene stehen — Auswertung und Modell sind
            immer nebeneinander zu sehen.</p>`
        },
        {
          titel: 'Rechter Rand',
          wo: 'Leiste rechts',
          braucht: () => !rechtsBelegt(),
          text: `<p>Auswertungen — Statik, Energie, Bericht — gehören nicht zu diesem Viewer. Das
            Panelgerüst dafür ist trotzdem da: ein Analysewerkzeug meldet sich dort als eigener
            Reiter an, ohne dass am Viewer etwas zu ändern wäre.</p>`
        },
        {
          titel: 'Erklärtexte erscheinen beim Überfahren',
          wo: 'überall',
          text: `<p>Die Erläuterungen zu den einzelnen Einstellungen stehen nicht mehr als
            Absätze in den Panels. Wer den Mauszeiger auf einem Bedienelement liegen lässt,
            bekommt nach einem kurzen Moment die zugehörige Erklärung als Sprechblase; mit der
            Tastatur erscheint sie, sobald das Element den Fokus hat. <kbd>Esc</kbd> blendet sie
            sofort aus.</p>
            <p>Sichtbar bleiben nur Statusmeldungen und Warnungen — beides will gesehen werden,
            ohne dass man es sucht.</p>`
        },
      ]
    },

    {
      id: 'modelle', symbol: '📦', titel: 'Modelle laden',
      lead: 'Woher die Geometrie kommt: eigenes Backend, Cesium ion, Karten und Gelände.',
      eintraege: [
        {
          titel: 'Backend',
          wo: 'Links › Modelle › Backend',
          text: `<p>Die Modelle des eigenen Servers (FastAPI + MinIO). Eine hochgeladene
            IFC-Datei wird dort zu 3D-Tiles aufbereitet und erscheint anschließend in dieser
            Liste. Von hier kommen auch die Schnitte, die der Zeichenmodus als Grundriss
            verwendet.</p>`
        },
        {
          titel: 'Cesium ion',
          wo: 'Links › Modelle › Cesium ion',
          text: `<p>Kachelsätze, die noch im eigenen ion-Konto liegen: Photogrammetrie,
            Punktwolken, 3D-Tiles. Die Vorschläge holt iLEEN erst beim ersten Klick ins
            Feld — ohne ion-Modell geht keine Anfrage an Cesium ion. Der Token steht unter
            Einstellungen › Kartendienste oder in <code>config.js</code>
            (<code>ionToken</code>).</p>`
        },
        {
          titel: 'Geladene Modelle',
          wo: 'Links › Modelle (oben angeheftet)',
          text: `<p>Was gerade in der Szene liegt, steht fest oben — mit Sichtbarkeit,
            Anspringen und der Lagekorrektur je Modell: <strong>Höhe</strong>,
            <strong>Drehung</strong>, <strong>Verschiebung</strong> und
            <strong>Geländeabgleich</strong> für Modelle, die nicht sauber georeferenziert
            ankommen.</p>`
        },
        {
          titel: 'Karten, Gelände, Gebäudekulisse',
          wo: 'Links › Modelle › Ebenen',
          text: `<p>Hintergrundkarten, Geländemodell und die amtliche Gebäudekulisse — alles
            ohne Cesium ion. <strong>Luftbild:</strong> die amtlichen Orthophotos (DOP20) von
            Rheinland-Pfalz, Hessen, NRW, Bayern und dem Saarland, sonst Sentinel-2.
            <strong>Gelände:</strong> das DGM5 der Länder (basemap.de) in Deutschland, sonst
            Terrain Tiles. <strong>Gebäude:</strong> LoD2 Deutschland (basemap.de 3D).
            Beide liefern Höhen über NHN; iLEEN rechnet sie über das EGM96-Geoid auf den
            Ellipsoid um, auf den sich auch die Modelle beziehen.</p>
            <p>Google-Karte und Google-Suche kommen direkt von Google und brauchen einen eigenen
            Schlüssel (Einstellungen › Kartendienste). Google-Luftbild und Google 3D Tiles gibt
            Google an Projekte im EWR seit Juli 2025 nicht mehr ab; iLEEN fragt erst direkt und
            holt sie sonst über Cesium ion — dafür braucht es den ion-Token. basemap.de steht
            zusätzlich als Vektorkarte zur Verfügung, die sich auf das Gelände legt.</p>`
        },
      ]
    },

    {
      id: 'ansicht', symbol: '📷', titel: 'Ansicht und Navigation',
      lead: 'Wie man sich im Modell bewegt, was man sieht und wie es aussieht.',
      eintraege: [
        {
          titel: 'Fliegen und Gehen',
          wo: 'Taste F · ⇧F',
          text: `<p><kbd>F</kbd> schaltet den Flugmodus ein: Fadenkreuz, <kbd>W</kbd>
            <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> zum Bewegen, am Trackpad ein Finger zum
            Umsehen, zwei Finger zum Schieben, Aufziehen ändert den Öffnungswinkel.
            <kbd>⇧F</kbd> geht stattdessen zu Fuß — mit Augenhöhe und Kollision.</p>
            <p><kbd>N</kbd> richtet die Kamera nach Norden aus. Das Navigations-HUD unten zeigt
            Modus, Kompass und Höhe.</p>`
        },
        {
          titel: 'In der Brille (VR)',
          wo: 'Navigations-HUD › 🥽 VR',
          text: `<p>Öffnet iLEEN im Browser der Brille (etwa Meta Quest 3), startet der Schalter VR gleich
            in einer Ebene über dem Viewer: das zuletzt geladene Backend-Modell, 1:1 begehbar. Das
            Fenster schließt mit ✕ oder <kbd>Esc</kbd>. Am Mac zeigt dieselbe Ebene eine Vorschau.</p>
            <p><b>1:1:</b> linker Stick gehen, rechter Stick drehen und schweben, Abzug auf den Boden
            springt, Abzug oder Griff auf ein Bauteil zeigt seine Daten. <b>Tischmodell:</b> das Gebäude
            verkleinert vor dir, der Raum bleibt sichtbar; mit dem Griff greifen und drehen.</p>
            <p><b>Verbinden ohne Entwicklermodus</b> (Hochschulbrillen): am Mac einmal
            <code>frontend/tools/quest-dienst.sh install</code>. Danach läuft der Server von selbst
            und passt sich Netzwechseln an. In der Brille <code>https://&lt;Mac-Adresse&gt;:5443</code>
            öffnen (<code>quest-dienst.sh status</code> zeigt sie) und die Zertifikatswarnung einmal
            über „Erweitert → Weiter“ bestätigen. Mac und Brille müssen im selben Netz sein.
            <b>Feste Adresse:</b> iPhone-Hotspot einschalten, Mac und Brille in das WLAN des iPhones —
            dann ist der Mac immer <code>https://172.20.10.14:5443</code>, an jedem Ort (einmal einrichten:
            <code>quest-festip.sh install</code>, fragt nach dem Passwort).</p>
            <p><b>Apple Vision Pro</b> (Safari, ab visionOS 2): Safari nimmt keine Zertifikatswarnung hin.
            Einmal <code>http://&lt;Mac-Adresse&gt;:5443/einrichten</code> öffnen, das Profil laden, unter
            Einstellungen › Allgemein › VPN &amp; Geräteverwaltung installieren und unter Allgemein › Info ›
            Zertifikatsvertrauenseinstellungen einschalten. Bedient wird mit Blick und Kneifen: hinsehen und
            kurz kneifen springt oder zeigt das Bauteil, lange kneifen zeigt immer die Info. Das Tablet schwebt
            vor dir, auf ihm tippt Kneifen, Kneifen und Ziehen rollt; Drehen und „Zum Start“ stehen unter
            Werkzeuge. Das Tischmodell bietet Safari auf der Vision Pro nicht an.</p>
            <p><b>Mehrere Brillen gemeinsam:</b> Öffnen mehrere Brillen iLEEN über denselben Mac, sehen sie sich
            gegenseitig (Kopf, Controller, Name, Zeigestrahl), und wer dazukommt, bekommt das Modell der anderen.
            Damit die Figuren dort stehen, wo die Menschen stehen, misst jede Brille einmal je Sitzung zwei Marken
            im Raum (2–4 m auseinander, alle in derselben Reihenfolge): Tablet › Gruppe › Kalibrieren, dann die
            Spitze des Controllers auf Marke 1 und 2 setzen und den Abzug halten — mit der Vision Pro Daumen und
            Zeigefinger auf der Marke zusammendrücken und halten, bis sie steht. Mit <b>Mitgehen</b> nimmt jeder,
            der geht, springt oder das Tischmodell greift, alle mit; ohne zeigt ein blasser Geist, wo die anderen
            wirklich stehen. Ausgewählte Bauteile, Messungen und — schaltbar — Ebenen und Höhenschnitt sehen alle.
            iLEEN am Mac schaut im Reiter Gruppe zu.</p>`
        },
        {
          titel: 'Gespeicherte Ansichten',
          wo: 'Links › Ansicht › Kamera',
          text: `<p>Kamerastandpunkt samt Tiefenschärfe unter einem Namen ablegen und später
            wieder anfliegen. Die Ansichten liegen im Browser (localStorage) und überleben das
            Neuladen der Seite.</p>`
        },
        {
          titel: 'Licht und Farben',
          wo: 'Links › Einstellungen · Taste L',
          text: `<p><kbd>L</kbd> schaltet das Kunstlicht: eine Grundaufhellung im Innenraum und
            eine Taschenlampe an der Kamera. Dazu kommen Weißabgleich der Szene, Sonnenstand und
            die Behandlung der Verglasung.</p>`
        },
        {
          titel: 'Punktwolken',
          wo: 'Links › Ansicht › Punktwolken',
          text: `<p>Punktgröße, Eye-Dome-Lighting und Farbmodus für geladene Punktwolken und
            Gaussian Splats. Splats lassen sich treffsicher anklicken — Messungen und Notizen
            setzen darauf auf.</p>`
        },
        {
          titel: 'Explosionsansicht und Geschosspläne',
          wo: 'Links › Ansicht',
          text: `<p>Die Explosionsansicht hebt die Geschosse auseinander, bis das Innere
            sichtbar wird. Derselbe Regler kann statt der Geschosse die zugehörigen
            <strong>Grundrisse</strong> als Bild in den Stapel legen — Plan und Bauwerk in
            derselben Höhenlage.</p>`
        },
        {
          titel: 'Bildebenen und Bildprojektion',
          wo: 'Links › Ansicht',
          text: `<p><strong>Bildebenen</strong> hängen ein Foto, einen Bestandsplan oder eine
            Fassadenabwicklung maßstäblich als Rechteck in den Raum — an ein Bauteil geheftet.
            Die <strong>Bildprojektion</strong> legt das Bild stattdessen auf die vorhandenen
            Flächen, wie ein Diaprojektor: sie folgt der Geometrie statt davorzustehen.</p>`
        },
        {
          titel: 'Präsentation: Folien aus Kamerapose und Text',
          wo: 'Links › Ansicht › Präsentation',
          text: `<p>Eine <strong>Folie</strong> ist ein Standpunkt der Kamera mit einem Text
            darüber: Kamera einstellen, <strong>＋ Folie aus Ansicht</strong>, Text schreiben.
            Die Folie merkt sich Ort, Blickrichtung und Öffnungswinkel. Den Text setzt man in
            einem kleinen Markdown (<code>**fett**</code>, <code>==markiert==</code>,
            <code># Titel</code>, Listen, Zitate) und zieht ihn im Bild an die gewünschte Stelle.</p>
            <p><strong>▶ Präsentieren</strong> fliegt von Folie zu Folie, wenn man mit
            <kbd>→</kbd> oder <kbd>Leertaste</kbd> weiterschaltet (<kbd>←</kbd> zurück,
            <kbd>Esc</kbd> beendet); zwischen den Flügen darf man sich frei umsehen.
            <strong>⏱ Auto</strong> spielt dieselbe Fahrt zeitgesteuert ab — pro Folie ein
            <em>Halt</em> und zwischen den Folien die <em>Flugzeit</em>.
            <strong>⤓ Video</strong> nimmt die Fahrt samt Text auf.</p>
            <p>Eine Folie kann auch die <strong>Szene</strong> tragen: welche Modelle geladen sind, welche
            Bauteiltypen fehlen, wo der Schnitt steht, wie offen die Explosion ist, welche Notizen im Bild
            stehen, Farben, Licht und Sonne. Beim Anlegen wird sie mit aufgenommen (<strong>⟳ Szene aufnehmen</strong>
            erneuert sie); zwischen zwei Folien springt, was sich nicht mischen lässt, zu Beginn der Fahrt,
            und Zahlen fahren mit — der Schnitt läuft durchs Haus, die Sonne wandert.</p>
            <p>Das Deck liegt im Browser und lässt sich als <code>.json</code> sichern und laden.
            Der Aufbau kommt aus splides (dort „Slide-Modus“); die Posen sind aber Weltkoordinaten
            und lassen sich nicht aus einem splides-Deck übernehmen.</p>`
        },
        {
          titel: '360°-Rundgang',
          wo: 'Links › Modelle › Rundgang',
          text: `<p>Ein Rundgang ist eine Liste von Standpunkten mit Weltlage, Blickrichtung und
            je einem equirectangularen Panorama. Ein Klick auf einen Standpunkt fliegt dorthin
            und legt das Panorama von innen auf eine Kugel um die Kamera — Matterport-artig,
            aber im georeferenzierten Modell und damit deckungsgleich mit der Geometrie.</p>`
        },
      ]
    },

    {
      id: 'bauteile', symbol: '🏗️', titel: 'Bauteile',
      lead: () => 'Filtern, isolieren, Eigenschaften lesen' +
        (raeume() || kollisionen() ? ', Räume und Kollisionen prüfen.' : '.'),
      eintraege: [
        {
          titel: 'Filter',
          wo: 'Links › Bauteile › Filter',
          text: `<p>Blendet nach IFC-Klasse, Geschoss und Merkmal ein und aus. Der Filter
            arbeitet auf den geladenen Kachelsätzen und ist unabhängig vom Ausblenden einzelner
            Bauteile.</p>`
        },
        {
          titel: 'Eigenschaften und Rollen',
          wo: 'Klick auf ein Bauteil',
          text: `<p>Ein Klick zeigt die Eigenschaften des getroffenen Bauteils. Die Anzeige ist
            rollenbasiert: je nachdem, ob ein Bauteil tragend, raumabschließend oder
            haustechnisch ist, stehen andere Merkmale oben.</p>`
        },
        {
          titel: 'Ausblenden und Isolieren',
          wo: 'Tasten H · ⇧H · I',
          text: `<p><kbd>H</kbd> blendet das angeklickte Bauteil aus, <kbd>⇧H</kbd> holt alle
            ausgeblendeten zurück. <kbd>I</kbd> isoliert stattdessen: alles außer der Auswahl
            verschwindet. Die Google-Freistellung räumt zusätzlich die Weltkulisse um die
            eigenen Modelle frei.</p>`
        },
        {
          titel: 'Räume und Nutzung',
          wo: 'Links › Bauteile › Räume',
          braucht: raeume,
          text: `<p>Räume aus dem Modell mit ihrer Nutzung, Fläche und Zuordnung — die
            Grundlage für Raumbuch und Flächenbilanz.</p>`
        },
        {
          titel: 'Kollisionsprüfung',
          wo: 'Links › Bauteile › Kollisionen',
          braucht: kollisionen,
          text: `<p>Sucht Durchdringungen zwischen Fachmodellen und listet die Fundstellen zum
            Anspringen auf. Ein Befund lässt sich als Thema übernehmen und damit über BCF
            weitergeben.</p>`
        },
      ]
    },

    {
      id: 'aufmass', symbol: '📐', titel: 'Aufmaß und Messen',
      lead: 'Ein Modus für alles: aus der Zahl der Punkte ergibt sich, was gemessen wird.',
      eintraege: [
        {
          titel: 'Der eine Messmodus',
          wo: 'Links › Werkzeuge › Messen',
          text: `<p>Es gibt kein Umschalten zwischen Länge, Fläche und Volumen. Man setzt eine
            Kette von Punkten, und die Zahl der Punkte entscheidet:</p>
            <ul>
              <li><strong>ein Punkt</strong> — Koordinate und Höhe</li>
              <li><strong>zwei Punkte</strong> — Strecke, waagerecht und senkrecht zerlegt</li>
              <li><strong>drei und mehr</strong> — Fläche des aufgespannten Polygons</li>
              <li><strong>geschlossen plus Höhe</strong> — Volumen</li>
            </ul>
            <p>Gemessen wird auf IFC-Geometrie, B3DM-Netzen, Punktwolken und Gaussian Splats
            gleichermaßen.</p>`
        },
        {
          titel: 'Fang',
          wo: 'Links › Werkzeuge › Messen',
          text: `<p>Der Fang zieht den Messpunkt auf Ecken, Kanten und Flächen des getroffenen
            Bauteils. Ohne ihn liegt der Punkt genau dort, wo der Strahl auftrifft — was bei
            Punktwolken oft die bessere Wahl ist.</p>`
        },
        {
          titel: 'Topografisches Aufmaß',
          wo: 'Links › Werkzeuge › Messen',
          text: `<p>Volumen aus den Punkten selbst statt aus einem Raster über dem Polygon:
            gedacht für Halden, Baugruben und Geländeschnitte. Im Ergebnis lassen sich
            Höhenlinienabstand und Darstellung nachstellen, ohne neu zu messen.</p>`
        },
        {
          titel: 'Mengen, Massen und CO₂',
          wo: 'Rechts · aus dem Aufmaß',
          braucht: () => !!window.AufmassMengen,
          text: `<p>Zu einem gemessenen Bauteil kommen Baustoff, Masse und der graue
            Treibhausgasausstoß seiner Herstellung. Damit wird aus einem Messpunkt eine
            Mengenangabe, die in den Bericht kann.</p>`
        },
        {
          titel: 'Messprotokoll der Sitzung',
          wo: 'Links › Werkzeuge › Messen › Sitzung',
          text: `<p>Alle Messungen einer Sitzung in einer Liste, mit Zeitpunkt und Bezug zum
            Bauteil — nachvollziehbar und als Ganzes exportierbar.</p>`
        },
      ]
    },

    {
      id: 'schnitte', symbol: '✂️', titel: 'Schnitte',
      lead: 'Hineinschauen: eine Box über alle Modelle, dazu Scheiben quer durch das Bauwerk.',
      eintraege: [
        {
          titel: 'Die Box',
          wo: 'Links › Werkzeuge › Schnitte',
          text: `<p><strong>✂ Schnitt starten</strong> legt eine Box um alle geladenen Modelle.
            Sie wird an ihren sechs Seiten aufgeschnitten — an den Griffen im Bild, an den Kanten
            der Schnittkarte oder mit Zahlen im Panel. <strong>Bauteil</strong> legt einen
            Meterwürfel an eine angeklickte Stelle, <strong>Einpassen</strong> die Box genau um das
            angeklickte Bauteil, <strong>Ganz</strong> wieder um die ganze Szene. Die Knöpfe je
            Geschoss schneiden einen Grundriss: von knapp unter der Rohdecke bis 1,20 m darüber.</p>
            <p><strong>Innen behalten</strong> lässt nur stehen, was in der Box liegt;
            <strong>Innen weg</strong> nimmt genau das heraus — der Blick geht an dieser Stelle ins
            Bauwerk.</p>`
        },
        {
          titel: 'Scheiben',
          wo: 'Links › Werkzeuge › Schnitte › Scheiben',
          text: `<p>Eine Scheibe ist ein senkrechter Streifen mit einer Dicke, quer durch das
            Bauwerk — entlang <strong>X</strong>, <strong>Y</strong> oder einer frei gezogenen
            <strong>Linie</strong> (✎). Auf der Schnittkarte wird sie an den Kanten dicker oder
            dünner, in der Mitte verschoben und am runden Griff gedreht. Gibt es Scheiben, bleibt
            nur stehen, was in der Box <em>und</em> in einer der Scheiben liegt.</p>`
        },
        {
          titel: 'Die Schnittkarte',
          wo: 'oben rechts über der Szene',
          text: `<p>Eine Draufsicht der Szene, nach der Höhe eingefärbt, mit einer Höhenleiste
            daneben. Die Box wird an ihren Kanten eingeschoben: von unten gezogen schneidet sie den
            Süden weg, von oben den Norden, links und rechts ebenso; an der Leiste unten und oben.
            <strong>Norden</strong> und <strong>Modellachsen</strong> drehen Box und Karte.</p>`
        },
        {
          titel: 'Schnittflächen',
          wo: 'Links › Werkzeuge › Schnitte › Rahmen und Darstellung',
          text: `<p>Cesium schließt Schnitte nicht — eine geschnittene Wand ist innen hohl. Die
            Rückseiten, die man durch das Loch sieht, werden dunkel und schraffiert gezeichnet; so
            liest sich der Schnitt wie im Plan. Ohne Füllung schaut man durch das Bauteil hindurch,
            richtig zum Prüfen von Kanten und doppelten Flächen. Geschnitten werden IFC-Modelle,
            Netze und Punktwolken gleichermaßen.</p>`
        },
        {
          titel: 'Als Detail zeichnen',
          wo: 'Links › Werkzeuge › Schnitte',
          braucht: () => amViewer('Plan2D'),
          text: `<p>Die Box geht als Ausschnitt ans Backend und kommt als maßstäblicher Schnitt
            in den Zeichenmodus zurück: <strong>XY</strong> als Grundriss, <strong>XZ</strong> und
            <strong>YZ</strong> senkrecht. Der Regler schiebt die Zeichenebene von einer Kante der
            Box zur anderen; eine Scheibe zeichnet sich mit <strong>◫</strong> als Schnitt entlang
            ihrer Linie. Das geht nur bei Modellen aus dem eigenen Backend — gezeichnet wird aus
            der IFC-Quelle.</p>`
        },
      ]
    },

    {
      id: 'notizen', symbol: '🏷️', titel: 'Notizen, Themen und BCF',
      lead: 'Vom Klebezettel im Modell zum nachvollziehbaren Vorgang.',
      eintraege: [
        {
          titel: 'Notizen setzen',
          wo: 'Links › Notizen · Taste C',
          text: `<p><kbd>C</kbd> schaltet den Notizmodus ein. Eine Notiz haftet an dem, was
            angeklickt wurde — IFC-Bauteil, B3DM-Netz, Splat oder freier Punkt im Raum. Text,
            Bilder und Anhänge kommen dazu; die Notizen liegen im Browser, die Anhänge in der
            IndexedDB.</p>`
        },
        {
          titel: 'Themen und BCF',
          wo: 'Rechts › Themen & BCF',
          braucht: () => reiter('issues'),
          text: `<p>Was für eine Begehung reicht, reicht für ein Bauvorhaben nicht. Der
            Themenbereich ergänzt drei Dinge:</p>
            <ul>
              <li><strong>Bearbeiten mit Verlauf</strong> — jede Änderung wird ein Stand</li>
              <li><strong>Zuständigkeit und Status</strong> — wer, bis wann, wie weit</li>
              <li><strong>BCF hinein und hinaus</strong> — Austausch mit jeder anderen
                BIM-Software</li>
            </ul>
            <p>Themen liegen im Backend und stehen damit nicht nur auf dem eigenen
            Rechner.</p>`
        },
        {
          titel: 'Als BCF weitergeben',
          wo: 'Links › Notizen',
          braucht: () => !reiter('issues'),
          text: `<p><strong>BCF</strong> unter der Notizliste schreibt alle Notizen als
            BCF-2.1-Paket — mit Blickpunkt und Bauteilbezug, lesbar in jeder anderen
            BIM-Software. <strong>JSON</strong> sichert sie verlustfrei für iLEEN selbst.</p>`
        },
      ]
    },

    {
      id: 'sensoren', symbol: '📈', titel: 'Sensorströme',
      lead: 'Messwerte, die sich ändern, ohne dass das Modell neu gekachelt wird: vom Broker über das Backend bis ins Bild.',
      eintraege: [
        {
          titel: 'Wie der Strom fließt',
          wo: 'Überblick',
          text: `<p>Geometrie und Zustand gehen getrennte Wege. Das Modell wird einmal gekachelt
            und liegt danach fest; Messwerte ändern sich im Minutentakt und laufen deshalb
            <strong>nie durch den Tiler</strong>, sondern durch diese Kette:</p>
            <table class="ileen-hilfe__befehle">
              <tr><td>Quelle</td><td>Sensor oder Generator schreibt ins Topic <code>ileen.sensor.messwerte</code></td></tr>
              <tr><td>Broker</td><td>gaecos Kafka — der Transport, nicht die Ablage</td></tr>
              <tr><td>Backend</td><td>hört zu und legt jeden Wert in der Zeitreihe ab</td></tr>
              <tr><td>Viewer</td><td>fragt alle zehn Sekunden den Stand ab und färbt die Geschosse</td></tr>
            </table>
            <p>Verbunden wird über die <strong>IRI</strong> des Bauteils, nicht über eine eigene
            Kennung: der Sensor kennt die GlobalId seines Ankerbauteils, und die steht in der
            Batch Table jeder Kachel. Das Campusmodell hat keine Räume; die Sensoren hängen deshalb
            an <strong>Zonen</strong>, und die Zonen sind die Geschosse.</p>
            <p>Jede Stufe darf fehlen, ohne dass die übrigen stehen bleiben: ohne Broker startet das
            Backend trotzdem, ohne Backend läuft der Viewer trotzdem.</p>`
        },
        {
          titel: 'Den Broker ein- und ausschalten',
          wo: 'Terminal · Verzeichnis des gaeco-Stacks',
          text: `<p>Für den Messwertstrom braucht es von gaeco <strong>nur den Broker</strong> —
            Keycloak, InstanceService und die übrigen Dienste dürfen aus sein.</p>
            <table class="ileen-hilfe__befehle">
              <tr><td>Broker starten</td><td><code>docker compose up -d gaeco-broker</code></td></tr>
              <tr><td>Broker anhalten</td><td><code>docker compose stop gaeco-broker</code></td></tr>
              <tr><td>Läuft er?</td><td><code>docker ps --filter name=gaeco-broker</code></td></tr>
            </table>
            <p>Von außen ist er unter <code>localhost:9092</code> zu erreichen, aus dem
            Backend-Container unter <code>gaeco-broker:29092</code> — der Container hängt dafür
            zusätzlich in gaecos Netz <code>gaeco-local</code>.</p>`
        },
        {
          titel: 'Einen Strom starten und beenden',
          wo: 'Terminal · Verzeichnis backend/',
          text: `<p>Solange es keine echten Sensoren gibt, liefert ein Generator plausible Werte
            für 24 Sensoren: Raumtemperatur je Geschoss (Nord und Süd), Wirkleistung,
            Photovoltaik, Globalstrahlung, Außentemperatur und den Gesamtzähler.</p>
            <table class="ileen-hilfe__befehle">
              <tr><td>Strom starten</td><td><code>python3 scripts/sensor_demo.py --live --kafka</code></td></tr>
              <tr><td>Beenden</td><td><kbd>Strg</kbd> + <kbd>C</kbd></td></tr>
              <tr><td>Im Hintergrund starten</td><td><code>nohup python3 scripts/sensor_demo.py --live --kafka &gt; /tmp/sensorstrom.log 2&gt;&amp;1 &amp; echo $! &gt; /tmp/sensorstrom.pid</code></td></tr>
              <tr><td>Hintergrundstrom beenden</td><td><code>kill $(cat /tmp/sensorstrom.pid)</code></td></tr>
              <tr><td>Zeitraffer: ein Tag in 24 Minuten</td><td><code>python3 scripts/sensor_demo.py --live --raffer 60 --kafka</code></td></tr>
              <tr><td>Den letzten Tag nachliefern</td><td><code>python3 scripts/sensor_demo.py --verlauf 1d --ende $(date -u +%Y-%m-%dT%H:%M:%SZ) --kafka</code></td></tr>
            </table>
            <p><code>--kafka</code> ohne Angabe schreibt an <code>localhost:9092</code>; ein anderer
            Broker steht dahinter, etwa <code>--kafka rechner:9092</code>. Ohne <code>--kafka</code>
            gehen die Werte als JSON-Zeilen nach stdout.</p>
            <p><strong>Zeitraffer schreibt in die Zukunft.</strong> Mit <code>--raffer 60</code> läuft
            die Modellzeit sechzigmal schneller als die Uhr; nach einer Stunde liegen die Werte
            zweieinhalb Tage voraus. Der Viewer zeigt immer den <em>jüngsten</em> Wert und damit den
            aus der Zukunft — später eingespeiste, aktuelle Werte bleiben dahinter verborgen. Nach
            einer Vorführung deshalb die Zukunftswerte entfernen (unten).</p>`
        },
        {
          titel: 'Das Backend hört zu',
          wo: 'Terminal · Verzeichnis backend/',
          text: `<p>Der Zuhörer startet mit dem Backend-Container und endet mit ihm; einzuschalten ist
            nichts. Jeder Wert, der am Topic ankommt, landet in der Zeitreihe. Werte von Sensoren,
            die das Register nicht kennt, werden abgewiesen und gezählt, nicht still abgelegt.</p>
            <table class="ileen-hilfe__befehle">
              <tr><td>Was liegt in der Zeitreihe?</td><td><code>curl -s localhost:8100/sensoren/zahlen</code></td></tr>
              <tr><td>Die aktuellen Werte</td><td><code>curl -s localhost:8100/sensoren/stand</code></td></tr>
              <tr><td>Ist der Zuhörer verbunden?</td><td><code>docker compose logs api | grep Sensor-Kafka</code></td></tr>
              <tr><td>Werte aus einer Datei, ohne Broker</td><td><code>curl -s -X POST localhost:8100/sensoren/messwerte -H 'Content-Type: application/x-ndjson' --data-binary @werte.jsonl</code></td></tr>
            </table>
            <p>Fehlt der Broker, meldet der Zuhörer das <strong>einmal</strong> und versucht es in
            wachsenden Abständen weiter; das Backend selbst läuft normal. Ganz abschalten:
            <code>ILEEN_KAFKA_BROKER= docker compose up -d api</code> — dann wird gar nicht erst
            verbunden, und im Protokoll steht „kein Broker eingerichtet".</p>`
        },
        {
          titel: 'Im Viewer ansehen',
          wo: 'Linke Leiste · 📈 Sensoren',
          text: `<p>Ist ein Backend eingerichtet, holt der Viewer die Werte von selbst. Ein Klick
            auf <strong>📈</strong> in der linken Leiste öffnet das Sensor-Panel und färbt das
            Modell zugleich ein; ein zweiter Klick oder das ✕ schließt beides. Wer das Panel nicht
            öffnet, sieht sein Modell unverändert — ein Modell soll nicht ungefragt die Farbe
            wechseln.</p>
            <p>Das Panel zeigt je Geschoss den Wert und dieselbe Farbe wie im Modell, darunter die
            Legende mit Zahlen und die übrigen Sensoren. Oben umschalten zwischen
            <em>Raumtemperatur</em> und <em>Wirkleistung</em> — das Modell folgt. Fühler, die die
            Geschossfarbe verschluckt, stehen beim Namen daneben: <strong>⚠</strong> für einen
            Ausreißer, <strong>◷</strong> für einen Fühler ohne frischen Wert. Steht oben
            <strong>in der Zukunft</strong>, hat ein Zeitraffer vorausgeschrieben (unten:
            Zeitreihe bereinigen). Offen oder zu wird gemerkt.</p>
            <p>Dasselbe geht auch aus der Browser-Konsole:</p>
            <table class="ileen-hilfe__befehle">
              <tr><td>Panel öffnen · schließen</td><td><code>SensorPanel.oeffnen()</code> · <code>SensorPanel.schliessen()</code></td></tr>
              <tr><td>Geschosse nach Raumtemperatur färben</td><td><code>SensorFarben.an()</code></td></tr>
              <tr><td>… nach Wirkleistung</td><td><code>SensorFarben.an('wirkleistung')</code></td></tr>
              <tr><td>Einfärbung aus, Filterfarben zurück</td><td><code>SensorFarben.aus()</code></td></tr>
              <tr><td>Die Werte je Geschoss</td><td><code>SensorFarben.zonenwerte()</code></td></tr>
              <tr><td>Alle Sensoren mit letztem Wert</td><td><code>SensorStore.stand()</code></td></tr>
              <tr><td>Abfragen anhalten · wieder aufnehmen</td><td><code>SensorStore.beenden()</code> · <code>SensorStore.starten()</code></td></tr>
            </table>
            <p>Die Raumtemperatur läuft von Blau (18 °C, Nachtabsenkung) über Hell nach Rot (24 °C).
            <strong>Entsättigt</strong> heißt veraltet — der Wert ist älter als das Dreifache seines
            Messtakts. <strong>Magenta</strong> heißt Ausreißer: beide Fühler eines Geschosses
            außerhalb ihres Messbereichs. Liefert nur einer von beiden einen Ausreißer, zeigt das
            Geschoss den gesunden Wert.</p>
            <p>Ist das ganze Modell entsättigt, arbeitet nicht die Darstellung falsch, sondern es
            kommen keine frischen Werte: Strom und Broker prüfen.</p>
            <p>Typfilter und Bauteil-Hervorhebung bleiben dabei erhalten; ein ausgewähltes Bauteil
            ist auch in einem eingefärbten Geschoss zu erkennen.</p>`
        },
        {
          titel: 'Zeitreihe bereinigen',
          wo: 'Terminal · Verzeichnis backend/',
          text: `<p>Nach einer Vorführung im Zeitraffer liegen Werte in der Zukunft. Dieser Befehl
            entfernt genau diese und lässt alles bis zum jetzigen Zeitpunkt stehen:</p>
            <table class="ileen-hilfe__befehle">
              <tr><td>Zukunftswerte entfernen</td><td><code>docker exec cesium-api python -c "import sqlite3,os,time; c=sqlite3.connect(os.environ['ILEEN_SENSOR_DB']); n=c.execute('DELETE FROM messwert WHERE zeit &gt; ?', (time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),)).rowcount; c.commit(); print(n, 'Werte entfernt')"</code></td></tr>
              <tr><td>Alles löschen und neu beginnen</td><td><code>docker compose stop api &amp;&amp; rm data/sensoren/zeitreihe.db* &amp;&amp; docker compose start api</code></td></tr>
            </table>
            <p>Das Register — welche Sensoren es gibt und woran sie hängen — ist davon nicht
            betroffen; es steht in <code>data/sensoren.csv</code> und <code>data/zonen.csv</code>.</p>`
        },
      ]
    },

    {
      id: 'gaeco', symbol: '🔗', titel: 'iLEEN in gaeco',
      lead: 'iLEEN und iLEEN-view als Module in der gaeco-Plattform: links der Viewer, rechts der Graph — und ein Klick verbindet beide.',
      eintraege: [
        {
          titel: 'Was man sieht',
          wo: 'gaeco · Navigation › iLEEN',
          text: `<p>In gaeco (<code>http://localhost:5000</code>) steht iLEEN als eigener Eintrag in
            der Navigation. Links läuft iLEEN vollständig, mit allen Werkzeugen; rechts zeigt eine
            Seitenleiste gaecos Instanzgraphen. In der Kopfzeile wählt man den <strong>UseCase</strong>
            — das Sichtfenster in gaeco — und sieht, ob der Viewer verbunden ist.</p>
            <table class="ileen-hilfe__befehle">
              <tr><td>Auswahl</td><td>Bauteil in iLEEN anklicken → seine Instanz in gaeco, Eigenschaften, Beziehungen</td></tr>
              <tr><td>Beziehung anklicken</td><td>iLEEN hebt das Gegenüber hervor und fliegt hin</td></tr>
              <tr><td>Graph</td><td>alle Instanzen nach Klassen; „alle hervorheben“ färbt die Klasse in iLEEN ein</td></tr>
              <tr><td>Modelle</td><td>IFC-Modelle des Backends laden oder nach gaeco übertragen</td></tr>
            </table>`
        },
        {
          titel: 'Ein Modell nach gaeco übertragen',
          wo: 'Seitenleiste › Modelle',
          text: `<p>„Nach gaeco übertragen“ legt Projekt, Grundstück, Gebäude, Geschosse, Räume und
            alle Bauteile als Instanzen in den gewählten UseCase — mit ihren Eigenschaften und den
            Beziehungen <em>enthält</em>, <em>besteht aus</em> und <em>Füllung</em> (Wand → Fenster).
            Jede Instanz trägt eine Kennung, die sich aus der GlobalId des Bauteils errechnet;
            dasselbe Bauteil landet deshalb bei jeder Übertragung auf derselben Instanz.</p>
            <p>gaeco liest die Übertragung in eigenem Takt — rund 75 Bauteile je Sekunde, danach die
            Beziehungen. Unter dem Modell steht erst „gaeco verarbeitet …“, dann
            „✓ in gaeco übernommen“; erst dann findet die Auswahl die Instanzen. Ein Modell mit
            20 000 Bauteilen braucht gut zehn Minuten. Übertragen darf nur, wer den UseCase in gaeco
            sehen darf.</p>`
        },
        {
          titel: 'Wenn etwas fehlt',
          wo: 'Kopfzeile des Moduls',
          text: `<table class="ileen-hilfe__befehle">
              <tr><td>„iLEEN antwortet nicht“</td><td>Läuft der Viewer? Steht gaecos Adresse in <code>ILEEN_CONFIG.gaecoOrigins</code>?</td></tr>
              <tr><td>„Nicht in gaeco“</td><td>Das Modell ist noch nicht übertragen oder noch nicht übernommen — Reiter Modelle</td></tr>
              <tr><td>„HTTP 404“ beim Übertragen</td><td>Das Backend läuft ohne die Route <code>/gaeco</code> — neu bauen</td></tr>
              <tr><td>„gaeco liest diese Übertragung nicht“</td><td>gaecos instance-server neu starten (er abonniert nur beim Start)</td></tr>
              <tr><td>kein Eintrag „iLEEN“</td><td>ab- und wieder anmelden</td></tr>
              <tr><td>kein UseCase „iLEEN“</td><td><code>python3 gaeco/einrichten.py</code> im iLEEN-Verzeichnis</td></tr>
            </table>
            <p>Die ganze Einrichtung steht in <code>GAECO-INTEGRATION.md</code>.</p>`
        },
      ]
    },

    {
      id: 'plan', symbol: '📋', titel: 'Zeichenmodus (Plan 2D)',
      lead: 'Aus dem Schnitt wird eine maßstäbliche Zeichnung — und aus der Zeichnung eine Statik.',
      eintraege: [
        {
          titel: 'Grundriss und Schnitt',
          wo: 'Links › Werkzeuge › Plan',
          braucht: () => amViewer('Plan2D'),
          text: `<p>Der Zeichenmodus stellt die Schnittfiguren des Backends maßstäblich dar —
            oder eine eingelesene PDF-Vorlage, die sich über zwei bekannte Punkte einmessen
            lässt. Raumstempel, Bemaßung und Beschriftung kommen darüber.</p>`
        },
        {
          titel: 'Bemaßen, beschriften, Symbole',
          wo: 'Links › Werkzeuge › Plan',
          braucht: () => amViewer('Plan2D'),
          text: `<p>Maßketten, Texte, Bauteilsymbole und Medien am Plan. Die Zeichnung bleibt
            dabei an das Modell gebunden: was im Plan angeklickt wird, ist auch in der Szene
            das getroffene Bauteil.</p>`
        },
        {
          titel: 'Lasten und Bewehrung',
          wo: 'Links › Werkzeuge › Plan',
          braucht: () => amViewer('Plan2D'),
          text: `<p>Flächen-, Linien- und Einzellasten werden im Grundriss eingetragen.
            Schal- und Bewehrungsskizzen mit Biegeformen entstehen im selben Blatt — die
            Zeichnung ist damit nicht nur Darstellung, sondern Eingabe.</p>`
        },
        {
          titel: 'FEM aus dem Grundriss',
          wo: 'Links › Werkzeuge › Plan › FEM',
          braucht: () => amViewer('Plan2D'),
          text: `<p>Hier schließt sich der Kreis: aus dem Grundriss und den eingetragenen Lasten
            entsteht ein Rechenmodell für <strong>eine Decke</strong>, das im Backend gelöst wird.
            Ergebnis sind Schnittgrößen, Verformungen und die erforderliche Bewehrung.</p>`
        },
        {
          titel: 'Blätter und Planbrowser',
          wo: 'Links › Werkzeuge › Plan',
          braucht: () => amViewer('Plan2D'),
          text: `<p>Mehrere Zeichnungen werden zu Blättern zusammengestellt, mit Rahmen und
            Schriftfeld, und über den Planbrowser wiedergefunden.</p>`
        },
      ]
    },

    {
      id: 'tragwerk', symbol: '⬓', titel: 'Tragwerk',
      lead: 'Von der einzelnen Decke über den Lastabtrag des ganzen Hauses bis zum Bauteil im Raum.',
      eintraege: [
        {
          titel: 'Lastabtrag',
          wo: 'Rechts › Lastabtrag',
          braucht: () => reiter('tragwerk'),
          text: `<p>Während die Plan-FEM <em>eine</em> Decke rechnet, führt der Lastabtrag die
            Geschosse zusammen: Deckenlasten werden auf Wände und Stützen verteilt, die
            Geschosskette nach unten fortgeschrieben und die Gründungslasten ausgewiesen. Der
            Nachweis für Wand und Stütze hängt daran.</p>`
        },
        {
          titel: 'Eingriffe',
          wo: 'Rechts › Lastabtrag',
          braucht: () => amViewer('TragwerkEingriffe'),
          text: `<p>Ein geplanter Durchbruch, eine entfernte Wand, eine zusätzliche Stütze:
            Eingriffe werden am Modell gesetzt und der Lastabtrag damit erneut gerechnet. So
            steht neben dem Bestand immer die geplante Änderung.</p>`
        },
        {
          titel: 'FE-Browser',
          wo: 'Rechts › Lastabtrag',
          braucht: () => amViewer('FeBrowser'),
          text: `<p>Ein Lastabtrag über fünf Geschosse erzeugt fünf FE-Berichte mit je hundert
            Größen. Der FE-Browser legt Eingaben und Ergebnisse nebeneinander, sodass eine Zahl
            bis zu ihrer Herkunft zurückverfolgt werden kann.</p>`
        },
        {
          titel: 'Bauteil räumlich',
          wo: 'Rechts › Bauteil räumlich',
          braucht: () => reiter('volumen'),
          text: `<p>Der kürzeste Weg von einem Modell zu einer Spannungsverteilung: ein Bauteil
            anklicken, vernetzen, rechnen lassen. Das Ergebnis erscheint als Volumenkörper oder
            als Punktwolke mit Werten — direkt an der Stelle, an der das Bauteil im Modell
            steht. Dazu gehört die Netzstudie, die zeigt, ab welcher Netzfeinheit sich das
            Ergebnis nicht mehr bewegt.</p>`
        },
        {
          titel: 'Einsturz',
          wo: 'Rechts › Einsturz',
          braucht: () => reiter('einsturz'),
          text: `<p>Spielt eine Einsturzrechnung am Gebäudemodell ab: Tausende Bruchkörper an
            ihrem Ort im IFC, Bild für Bild, mit Rissen, die sich aus der gerechneten Öffnung
            ergeben, ausfallenden Stützen und brechenden Glasscheiben. Eine Zeitleiste zeigt Last
            und abgesackten Anteil, die Chronik springt zu jedem Ereignis und fliegt hin. Farbe
            nach Werkstoff, Schädigung oder Verschiebung; ein Klick auf einen Körper nennt Bauteil
            und Zeitpunkte. Gerechnet wird außerhalb — iLEEN zeigt, was eine Studie als Paket
            ablegt. Eine Robustheitsstudie, kein Standsicherheitsnachweis.</p>`
        },
        {
          titel: 'StaLite — Stabwerksstatik',
          wo: 'Rechts › StaLite',
          braucht: () => reiter('stalite'),
          text: `<p>Die Stabwerksstatik aus dem Schwesterprojekt TM_tools, eingebettet als
            Reiter: Stabwerke rechnen, Querschnitte bemessen, Ergebnisse als Skizze übernehmen.</p>`
        },
      ]
    },

    {
      id: 'energie', symbol: '🌡', titel: 'Energie',
      lead: 'Gebäudehülle, Monatsbilanz und Ertrag der Dachflächen.',
      eintraege: [
        {
          titel: 'GEG — Gebäudeenergie',
          wo: 'Rechts › GEG',
          braucht: () => reiter('geg'),
          text: `<p>Das Gegenstück zur Plan-FEM auf der energetischen Seite: aus der
            Gebäudehülle des Modells — Flächen, Aufbauten, Orientierung — entsteht die
            Nachweisrechnung nach GEG. Die Hülle wird dabei aus dem Modell abgeleitet und nicht
            von Hand aufgemessen.</p>`
        },
        {
          titel: 'Solaranalyse',
          wo: 'Rechts › Solar',
          braucht: () => reiter('solar'),
          text: `<p>Ein Klick auf ein Gebäude startet die Auswertung über die Google Solar API:
            nutzbare Dachfläche, Einstrahlung, mögliche Modulbelegung und eine Kostenrechnung
            über zwanzig Jahre. Benötigt <code>solarApiKey</code> in <code>config.js</code>.</p>`
        },
      ]
    },

    {
      id: 'konzept', symbol: '🏠', titel: 'Konzept und Bauzeit',
      lead: 'Entwerfen, bevor es ein Modell gibt — und den Ablauf sehen, wenn es eines gibt.',
      eintraege: [
        {
          titel: 'Bauplaner',
          wo: 'Links › Bauplaner',
          braucht: () => !!window.BauplanerPanel,
          text: `<p>Ein Planungswerkzeug für Häuser: Bauteile aus einem Katalog auf ein Raster
            setzen, Geschosse stapeln, Dach aufsetzen. Daraus entsteht ein Baukörper, der sich
            wie ein geladenes Modell weiterverwenden lässt.</p>`
        },
        {
          titel: 'Städtebau: Zeile und Grundstück',
          wo: 'Links › Bauplaner › Aus einer Linie erzeugen',
          braucht: () => !!window.BauplanerPanel,
          text: `<p>Wie in Forma: eine Leitlinie klicken — gerade, mit Bögen oder als Spline —,
            und entlang ihrer entsteht eine Gebäudezeile aus Baukörpern, Geschoss für Geschoss,
            in gleiche Abschnitte geteilt, auf Wunsch mit Fugen und gestaffelter Höhe. Die
            Fassaden folgen der Krümmung, ein Achsraster mit gleichen Feldern läuft mit.
            Daneben stehen BGF, Grundfläche, Rauminhalt und der engste Radius. Ein Grundstück
            baut nichts, sondern misst: GRZ und GFZ der Baukörper darin, mit Ampel gegen die
            Werte des Bebauungsplans. Alles bleibt änderbar — die Linie ist die Quelle.</p>`
        },
        {
          titel: 'Konzept-Assistent',
          wo: 'Links › Konzept',
          braucht: () => !!window.KonzeptPanel,
          text: `<p>Der Raumkonzept-Assistent führt vom Raumprogramm zum Baukörper: Räume mit
            Bedarf und Beziehung eingeben, prüfen lassen, Varianten vergleichen. Die Prüfungen
            melden sich gestuft — in Ordnung, Hinweis, Fehler.</p>`
        },
        {
          titel: 'Bauzeitsimulation (4D)',
          wo: 'Links › Konzept · Links › 4D',
          braucht: () => !!window.Sim4DHud,
          text: `<p>Zwei Wege zur Bauzeit: über den Terminplan des Konzepts oder über das
            Merkmal <code>stage</code> am geladenen Fachmodell. In beiden Fällen läuft dieselbe
            Zeitleiste — Balkenplan, Kalender und Kamerafahrten je Bauabschnitt inbegriffen.
            Ein Bericht zeigt, wie sicher die Zuordnung der Bauteile zu den Vorgängen ist und
            woher sie stammt.</p>`
        },
      ]
    },

    {
      id: 'bericht', symbol: '📄', titel: 'Bericht und Bauantrag',
      lead: 'Was in iLEEN entstanden ist, wird ein Dokument.',
      eintraege: [
        {
          titel: 'Bericht',
          wo: 'Rechts › Bericht',
          braucht: () => reiter('bericht'),
          text: `<p>Führt Messungen, Nachweise, Skizzen, Pläne und Themen zu einem Dokument
            zusammen — mit Deckblatt, Gliederung und Anlagen. Das Skizzenarchiv ist dabei das
            Zwischenformat zwischen „gerechnet" und „im Bericht".</p>`
        },
        {
          titel: 'BIM-Leistungsphasen',
          wo: 'Rechts › BIM-LP',
          braucht: () => reiter('bimlp'),
          text: `<p>Zeigt je Leistungsphase, welcher Informationsbedarf an das Modell besteht —
            als Abgleich zwischen dem, was das Modell führt, und dem, was die Phase
            verlangt.</p>`
        },
        {
          titel: 'Flugverkehr',
          wo: 'Links › Flug',
          braucht: () => !!window.FlugTracker,
          text: `<p>Luftfahrzeuge über dem Modell in Echtzeit (OpenSky über das Backend) —
            gedacht für Standorte unter An- und Abflugrouten.</p>`
        },
      ]
    },

    {
      id: 'tasten', symbol: '⌨️', titel: 'Tastaturkürzel',
      lead: 'Die Kürzel wirken, solange der Fokus nicht in einem Schriftfeld steht.',
      eintraege: [
        {
          titel: 'Übersicht',
          wo: 'global',
          text: `<table class="ileen-hilfe__tasten">
            <tr><td>Seitenleiste ein- und ausfahren</td><td><kbd>M</kbd></td></tr>
            <tr><td>Bauteil ausblenden · alle zurückholen</td><td><kbd>H</kbd> · <kbd>⇧H</kbd></td></tr>
            <tr><td>Auswahl isolieren</td><td><kbd>I</kbd></td></tr>
            <tr><td>Notizmodus</td><td><kbd>C</kbd></td></tr>
            <tr><td>Fliegen · Gehen</td><td><kbd>F</kbd> · <kbd>⇧F</kbd></td></tr>
            <tr><td>Bewegen im Flug- und Gehmodus</td><td><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></td></tr>
            <tr><td>Kunstlicht und Taschenlampe</td><td><kbd>L</kbd></td></tr>
            <tr><td>Nach Norden ausrichten</td><td><kbd>N</kbd></td></tr>
            <tr><td>Bildrate einblenden</td><td><kbd>Strg/⌘</kbd> + <kbd>Alt</kbd> + <kbd>F</kbd></td></tr>
            <tr><td>Laufenden Vorgang abbrechen, Sprechblase schließen</td><td><kbd>Esc</kbd></td></tr>
            <tr><td>In der Präsentation: weiter · zurück · Anfang · Ende</td><td><kbd>→</kbd> <kbd>Leertaste</kbd> · <kbd>←</kbd> · <kbd>Pos1</kbd> · <kbd>Ende</kbd></td></tr>
          </table>`
        },
      ]
    },

    {
      id: 'rechtliches', symbol: '§', titel: 'Herkunft und Lizenz',
      lead: 'Wer es gemacht hat und wozu es verwendet werden darf.',
      eintraege: [
        {
          titel: 'iLEEN',
          wo: 'Hochschule Mainz',
          text: `<p>Viewer, Statik und Bauantrag am digitalen Gebäudemodell. Entstanden im
            BIM-Labor der Hochschule Mainz.</p>`
        },
        {
          titel: 'Lizenz',
          wo: '',
          text: `<p>© 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0. Nutzung für
            nichtkommerzielle Zwecke, Forschung und Lehre frei; alles Weitere nach Absprache.
            Das Backend steht unter AGPL-3.0. Verwendete Fremdsoftware, allen voran CesiumJS
            (Apache-2.0), ist in <code>THIRD-PARTY-NOTICES.md</code> aufgeführt.</p>`
        },
      ]
    },

  ];

  // ──────────────────────────────────────────────────────────────────────────
  // Aufbau
  // ──────────────────────────────────────────────────────────────────────────

  let wurzel = null;
  let sichtbar = [];

  /** Die Kapitel mit den Einträgen, deren Werkzeug geladen ist — ohne leere. */
  function sichtbareKapitel() {
    const da = (e) => {
      if (typeof e.braucht !== 'function') return true;
      // Eine Bedingung, die wirft, blendet ihren Eintrag aus, nicht das Handbuch.
      try { return !!e.braucht(); } catch (fehler) { return false; }
    };
    return KAPITEL
      .map((k) => Object.assign({}, k, {
        lead: typeof k.lead === 'function' ? k.lead() : k.lead,
        eintraege: k.eintraege.filter(da),
      }))
      .filter((k) => k.eintraege.length > 0);
  }

  function aufbauen() {
    if (wurzel && wurzel.isConnected) return wurzel;

    sichtbar = sichtbareKapitel();
    wurzel = document.createElement('div');
    wurzel.className = 'ileen-hilfe';
    wurzel.id = 'ileenHilfe';
    wurzel.innerHTML = `
      <div class="ileen-hilfe__fenster" role="dialog" aria-modal="true" aria-label="Handbuch">
        <div class="ileen-hilfe__kopf">
          <h2 class="ileen-hilfe__titel"><span>i</span>LEEN — Handbuch</h2>
          <input type="search" class="ileen-hilfe__suche" placeholder="Suchen …"
                 aria-label="Im Handbuch suchen">
          <span class="ileen-hilfe__werkzeuge">
            <button class="btn btn--sm" data-hilfe="drucken">Drucken</button>
            <button class="btn btn--sm" data-hilfe="zu" aria-label="Handbuch schließen">✕</button>
          </span>
        </div>
        <nav class="ileen-hilfe__nav">${navMarkup()}</nav>
        <div class="ileen-hilfe__inhalt">
          ${sichtbar.map(kapitelMarkup).join('')}
          <p class="ileen-hilfe__leer" hidden>Kein Eintrag enthält diesen Begriff.</p>
        </div>
      </div>
    `;
    document.body.appendChild(wurzel);
    verkabeln();
    return wurzel;
  }

  function navMarkup() {
    return sichtbar.map((k) => `
      <button class="ileen-hilfe__navknopf" data-ziel="${k.id}">
        <span aria-hidden="true">${k.symbol}</span><span>${k.titel}</span>
      </button>`).join('');
  }

  function kapitelMarkup(k) {
    return `
      <section class="ileen-hilfe__kapitel" id="hilfe-${k.id}">
        <h2>${k.symbol} ${k.titel}</h2>
        <p class="ileen-hilfe__lead">${k.lead}</p>
        ${k.eintraege.map((e) => `
          <article class="ileen-hilfe__eintrag">
            <h3>${e.titel}</h3>
            ${e.wo ? `<div class="ileen-hilfe__wo">${e.wo}</div>` : ''}
            ${e.text}
          </article>`).join('')}
      </section>`;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Bedienung
  // ──────────────────────────────────────────────────────────────────────────

  function verkabeln() {
    const inhalt = wurzel.querySelector('.ileen-hilfe__inhalt');

    wurzel.addEventListener('click', (e) => {
      const nav = e.target.closest('.ileen-hilfe__navknopf');
      if (nav) { springen(nav.dataset.ziel); return; }

      const knopf = e.target.closest('[data-hilfe]');
      if (knopf?.dataset.hilfe === 'zu') { schliessen(); return; }
      if (knopf?.dataset.hilfe === 'drucken') { window.print(); return; }

      // Klick neben das Fenster schließt — der Klick im Fenster nicht.
      if (e.target === wurzel) schliessen();
    });

    wurzel.querySelector('.ileen-hilfe__suche').addEventListener('input', (e) => {
      suchen(e.target.value);
    });

    // Welches Kapitel gerade oben steht, markiert die Navigation mit.
    inhalt.addEventListener('scroll', () => {
      let aktiv = null;
      wurzel.querySelectorAll('.ileen-hilfe__kapitel').forEach((abschnitt) => {
        if (abschnitt.hidden) return;
        if (abschnitt.getBoundingClientRect().top - inhalt.getBoundingClientRect().top <= 24) {
          aktiv = abschnitt.id.replace('hilfe-', '');
        }
      });
      markieren(aktiv);
    }, { passive: true });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && istOffen()) { e.stopPropagation(); schliessen(); }
    }, true);
  }

  function markieren(id) {
    wurzel.querySelectorAll('.ileen-hilfe__navknopf').forEach((b) => {
      b.classList.toggle('is-aktiv', b.dataset.ziel === id);
    });
  }

  function springen(id) {
    const ziel = wurzel.querySelector(`#hilfe-${CSS.escape(id)}`);
    if (!ziel) return;
    ziel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    markieren(id);
  }

  /**
   * Die Suche blendet Einträge aus, statt eine Trefferliste aufzubauen: so
   * bleibt die Gliederung stehen und man sieht, in welchem Kapitel ein Begriff
   * vorkommt. Ein Kapitel ohne Treffer verschwindet samt Navigationseintrag.
   */
  function suchen(begriff) {
    const wort = begriff.trim().toLowerCase();
    let treffer = 0;

    wurzel.querySelectorAll('.ileen-hilfe__kapitel').forEach((abschnitt) => {
      let imKapitel = 0;
      abschnitt.querySelectorAll('.ileen-hilfe__eintrag').forEach((eintrag) => {
        const passt = !wort || eintrag.textContent.toLowerCase().includes(wort);
        eintrag.hidden = !passt;
        if (passt) imKapitel++;
      });
      const kapitelPasst = imKapitel > 0
        || (!!wort && abschnitt.querySelector('h2').textContent.toLowerCase().includes(wort));
      if (kapitelPasst && !imKapitel) {
        abschnitt.querySelectorAll('.ileen-hilfe__eintrag').forEach((e) => { e.hidden = false; });
      }
      abschnitt.hidden = !kapitelPasst && !!wort;
      treffer += kapitelPasst ? 1 : 0;

      const id = abschnitt.id.replace('hilfe-', '');
      const knopf = wurzel.querySelector(`.ileen-hilfe__navknopf[data-ziel="${id}"]`);
      if (knopf) knopf.hidden = abschnitt.hidden;
    });

    wurzel.querySelector('.ileen-hilfe__leer').hidden = treffer > 0;
  }

  function istOffen() { return !!wurzel && wurzel.classList.contains('is-offen'); }

  function oeffnen(kapitelId) {
    aufbauen();
    wurzel.classList.add('is-offen');
    if (kapitelId) springen(kapitelId);
    else if (sichtbar.length) markieren(sichtbar[0].id);
    wurzel.querySelector('.ileen-hilfe__suche').focus();
  }

  function schliessen() {
    if (wurzel) wurzel.classList.remove('is-offen');
  }

  function umschalten(kapitelId) {
    istOffen() ? schliessen() : oeffnen(kapitelId);
  }

  return {
    oeffnen, schliessen, umschalten,
    get kapitel() { return KAPITEL; },
    /** Die Kennungen der Kapitel, die in dieser Fassung erscheinen. */
    get sichtbar() { return sichtbareKapitel().map((k) => k.id); },
  };
})();

window.ILeenHilfe = ILeenHilfe;
