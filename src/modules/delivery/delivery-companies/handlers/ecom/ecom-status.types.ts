export interface EcomCatalogEntry {
  id?: number | string | null;
  libelle?: string | null;
}

export interface EcomHistoryEntryDto {
  date?: string | null;
  ville?: number | string | null;
  situation?: string | null;
  commentaire?: string | null;
  [key: string]: unknown;
}

export interface EcomParcelDto {
  tracking?: string | null;
  id_externe?: string | null;
  trouve?: boolean | null;
  date_creation?: string | null;
  situation?: string | null;
  id_situation?: number | string | null;
  etat_logistique?: string | null;
  id_etat_logistique?: number | string | null;
  date_action?: string | null;
  nom_complet?: string | null;
  mobile?: string | null;
  commune?: string | null;
  id_wilaya?: number | string | null;
  article?: string | null;
  quantite?: number | null;
  total?: number | null;
  note_fournisseur?: string | null;
  stopdesk?: number | boolean | null;
  encaisser?: boolean | null;
  recouvert?: boolean | null;
  tarif_si_livrer?: number | null;
  tarif_si_annuler?: number | null;
  historique?: EcomHistoryEntryDto[] | null;
  [key: string]: unknown;
}

export interface EcomExternalIdStatusDto {
  id_externe?: string | null;
  trouve?: boolean | null;
  colis?: EcomParcelDto[] | null;
}

export interface EcomStatusResponseDto {
  trackings?: EcomParcelDto[] | null;
  id_externes?: EcomExternalIdStatusDto[] | null;
}

export interface EcomHistoryResultDto {
  tracking?: string | null;
  id_externe?: string | null;
  trouve?: boolean | null;
  historique?: EcomHistoryEntryDto[] | null;
}

export interface EcomHistoryResponseDto {
  resultats?: EcomHistoryResultDto[] | null;
}
