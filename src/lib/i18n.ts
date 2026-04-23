// Traducciones de etiquetas de Steam (inglés → español).
// Se aplican sobre `localized_tag_name` (ya viene en inglés porque pedimos
// el inventario con `l=english`). Si no hay mapeo, devolvemos el texto tal cual.

const TYPE_ES: Record<string, string> = {
  Rifle: "Rifle",
  "Sniper Rifle": "Francotirador",
  SMG: "Subfusil",
  Pistol: "Pistola",
  Shotgun: "Escopeta",
  Machinegun: "Ametralladora",
  Knife: "Cuchillo",
  Gloves: "Guantes",
  Sticker: "Sticker",
  Container: "Caja",
  "Weapon Case": "Caja de armas",
  Agent: "Agente",
  Graffiti: "Graffiti",
  "Music Kit": "Música",
  Patch: "Parche",
  Collectible: "Coleccionable",
  Tool: "Herramienta",
  "Name Tag": "Etiqueta",
  Key: "Llave",
  Pass: "Pase",
  "Gift": "Regalo",
  Spray: "Graffiti",
  Pin: "Pin",
  "Base Grade Container": "Caja",
};

const EXTERIOR_ES: Record<string, string> = {
  "Factory New": "Recién Fabricado",
  "Minimal Wear": "Algo Desgastado",
  "Field-Tested": "Probado en Combate",
  "Well-Worn": "Muy Desgastado",
  "Battle-Scarred": "Deteriorado",
  "Not Painted": "Sin Pintar",
};

const RARITY_ES: Record<string, string> = {
  "Consumer Grade": "Consumidor",
  "Industrial Grade": "Industrial",
  "Mil-Spec Grade": "Militar",
  "Mil-Spec": "Militar",
  Restricted: "Restringido",
  Classified: "Clasificado",
  Covert: "Secreto",
  Contraband: "Contrabando",
  Extraordinary: "Extraordinario",
  Remarkable: "Notable",
  "High Grade": "Alto Grado",
  Distinguished: "Distinguido",
  Exotic: "Exótico",
  Master: "Maestro",
  "★": "★",
  "Base Grade": "Base",
  Superior: "Superior",
  Exceptional: "Excepcional",
};

const QUALITY_ES: Record<string, string> = {
  Normal: "",
  Souvenir: "Souvenir",
  "StatTrak™": "StatTrak™",
  "★": "★",
  "★ StatTrak™": "★ StatTrak™",
  Unique: "",
  Strange: "StatTrak™",
};

export function translateType(s: string | null | undefined): string {
  if (!s) return "Otros";
  return TYPE_ES[s] || s;
}
export function translateExterior(s: string | null | undefined): string | null {
  if (!s) return null;
  return EXTERIOR_ES[s] || s;
}
export function translateRarity(s: string | null | undefined): string | null {
  if (!s) return null;
  return RARITY_ES[s] || s;
}
export function translateQuality(s: string | null | undefined): string | null {
  if (!s) return null;
  const v = QUALITY_ES[s];
  if (v === "") return null; // "Normal" → no mostrar
  return v ?? s;
}
