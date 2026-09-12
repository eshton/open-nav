import type {
  InvoiceCategoryType,
  MarginSchemeType,
  PaymentMethodType,
  UnitOfMeasureType,
} from '@open-nav/core';
import type { DocumentLanguage } from './format.js';

type Dictionary = Record<string, string>;

/**
 * Document labels.
 *
 * Hungarian is the reference: an invoice issued in Hungary is a Hungarian
 * document, and the phrases the VAT Act requires on it are prescribed in
 * Hungarian. The English column is a courtesy translation for a foreign
 * recipient, not a substitute.
 */
const LABELS: Record<DocumentLanguage, Dictionary> = {
  hu: {
    invoice: 'SZÁMLA',
    simplifiedInvoice: 'EGYSZERŰSÍTETT SZÁMLA',
    aggregateInvoice: 'GYŰJTŐSZÁMLA',
    modificationDocument: 'MÓDOSÍTÓ OKIRAT',
    proforma: 'DÍJBEKÉRŐ',
    deliveryNote: 'SZÁLLÍTÓLEVÉL',
    receipt: 'NYUGTA',
    notTaxInvoice: 'Ez a dokumentum nem számla, adólevonásra nem alkalmas.',
    invoiceNumber: 'Számla sorszáma',
    issueDate: 'Számla kelte',
    deliveryDate: 'Teljesítés dátuma',
    deliveryPeriod: 'Elszámolási időszak',
    paymentDate: 'Fizetési határidő',
    paymentMethod: 'Fizetési mód',
    supplier: 'Eladó',
    customer: 'Vevő',
    taxNumber: 'Adószám',
    communityVatNumber: 'Közösségi adószám',
    thirdStateTaxId: 'Harmadik országbeli adószám',
    groupMemberTaxNumber: 'Csoporttag adószáma',
    bankAccount: 'Bankszámlaszám',
    fiscalRepresentative: 'Pénzügyi képviselő',
    originalInvoiceNumber: 'Eredeti számla sorszáma',
    lineNumber: 'Sor',
    description: 'Megnevezés',
    quantity: 'Mennyiség',
    unit: 'Egység',
    unitPrice: 'Egységár',
    netAmount: 'Nettó érték',
    vatRate: 'Áfa',
    vatAmount: 'Áfa érték',
    grossAmount: 'Bruttó érték',
    summary: 'Összesítés',
    summaryByVatRate: 'Áfa-összesítő',
    totalNet: 'Nettó összesen',
    totalVat: 'Áfa összesen',
    totalGross: 'Bruttó összesen',
    currency: 'Pénznem',
    exchangeRate: 'Árfolyam',
    inHuf: 'Forintban',
    exempt: 'Adómentes',
    outOfScope: 'Áfa tv. hatályán kívüli',
    reverseCharge: 'fordított adózás',
    cashAccounting: 'pénzforgalmi elszámolás',
    selfBilling: 'önszámlázás',
    marginTravel: 'különbözet szerinti szabályozás – utazási irodák',
    marginSecondHand: 'különbözet szerinti szabályozás – használt cikkek',
    marginArtwork: 'különbözet szerinti szabályozás – műalkotások',
    marginAntiques: 'különbözet szerinti szabályozás – gyűjteménydarabok és régiségek',
    newTransportMean: 'új közlekedési eszköz értékesítése',
    markings: 'Jogszabályi jelölések',
    notReported: 'Ez a dokumentum a NAV felé beküldött adatokból készült megjelenítés.',
    page: 'oldal',
  },
  en: {
    invoice: 'INVOICE',
    simplifiedInvoice: 'SIMPLIFIED INVOICE',
    aggregateInvoice: 'AGGREGATE INVOICE',
    modificationDocument: 'MODIFICATION DOCUMENT',
    proforma: 'PROFORMA INVOICE',
    deliveryNote: 'DELIVERY NOTE',
    receipt: 'RECEIPT',
    notTaxInvoice: 'This document is not a tax invoice and cannot be used for VAT deduction.',
    invoiceNumber: 'Invoice number',
    issueDate: 'Date of issue',
    deliveryDate: 'Date of supply',
    deliveryPeriod: 'Settlement period',
    paymentDate: 'Payment due',
    paymentMethod: 'Payment method',
    supplier: 'Supplier',
    customer: 'Customer',
    taxNumber: 'Tax number',
    communityVatNumber: 'Community VAT number',
    thirdStateTaxId: 'Third state tax id',
    groupMemberTaxNumber: 'Group member tax number',
    bankAccount: 'Bank account',
    fiscalRepresentative: 'Fiscal representative',
    originalInvoiceNumber: 'Original invoice number',
    lineNumber: 'No.',
    description: 'Description',
    quantity: 'Quantity',
    unit: 'Unit',
    unitPrice: 'Unit price',
    netAmount: 'Net amount',
    vatRate: 'VAT',
    vatAmount: 'VAT amount',
    grossAmount: 'Gross amount',
    summary: 'Summary',
    summaryByVatRate: 'VAT summary',
    totalNet: 'Total net',
    totalVat: 'Total VAT',
    totalGross: 'Total gross',
    currency: 'Currency',
    exchangeRate: 'Exchange rate',
    inHuf: 'In HUF',
    exempt: 'Exempt',
    outOfScope: 'Outside the scope of the VAT Act',
    reverseCharge: 'reverse charge',
    cashAccounting: 'cash accounting',
    selfBilling: 'self-billing',
    marginTravel: 'margin scheme — travel agents',
    marginSecondHand: 'margin scheme — second-hand goods',
    marginArtwork: 'margin scheme — works of art',
    marginAntiques: 'margin scheme — collectors items and antiques',
    newTransportMean: 'supply of a new means of transport',
    markings: 'Statutory markings',
    notReported: 'Rendered from the data reported to NAV.',
    page: 'page',
  },
  de: {
    invoice: 'RECHNUNG',
    simplifiedInvoice: 'VEREINFACHTE RECHNUNG',
    aggregateInvoice: 'SAMMELRECHNUNG',
    modificationDocument: 'ÄNDERUNGSBELEG',
    proforma: 'PROFORMARECHNUNG',
    deliveryNote: 'LIEFERSCHEIN',
    receipt: 'QUITTUNG',
    notTaxInvoice: 'Dieses Dokument ist keine Rechnung und berechtigt nicht zum Vorsteuerabzug.',
    invoiceNumber: 'Rechnungsnummer',
    issueDate: 'Rechnungsdatum',
    deliveryDate: 'Leistungsdatum',
    deliveryPeriod: 'Abrechnungszeitraum',
    paymentDate: 'Fälligkeitsdatum',
    paymentMethod: 'Zahlungsart',
    supplier: 'Verkäufer',
    customer: 'Käufer',
    taxNumber: 'Steuernummer',
    communityVatNumber: 'USt-IdNr.',
    thirdStateTaxId: 'Steuernummer Drittland',
    groupMemberTaxNumber: 'Steuernummer des Gruppenmitglieds',
    bankAccount: 'Bankkonto',
    fiscalRepresentative: 'Fiskalvertreter',
    originalInvoiceNumber: 'Ursprüngliche Rechnungsnummer',
    lineNumber: 'Nr.',
    description: 'Bezeichnung',
    quantity: 'Menge',
    unit: 'Einheit',
    unitPrice: 'Einzelpreis',
    netAmount: 'Nettobetrag',
    vatRate: 'USt',
    vatAmount: 'USt-Betrag',
    grossAmount: 'Bruttobetrag',
    summary: 'Zusammenfassung',
    summaryByVatRate: 'USt-Zusammenfassung',
    totalNet: 'Nettosumme',
    totalVat: 'USt-Summe',
    totalGross: 'Bruttosumme',
    currency: 'Währung',
    exchangeRate: 'Wechselkurs',
    inHuf: 'In HUF',
    exempt: 'Steuerfrei',
    outOfScope: 'Außerhalb des Anwendungsbereichs des UStG',
    reverseCharge: 'Steuerschuldnerschaft des Leistungsempfängers',
    cashAccounting: 'Ist-Besteuerung',
    selfBilling: 'Gutschrift',
    marginTravel: 'Differenzbesteuerung – Reiseleistungen',
    marginSecondHand: 'Differenzbesteuerung – Gebrauchtgegenstände',
    marginArtwork: 'Differenzbesteuerung – Kunstgegenstände',
    marginAntiques: 'Differenzbesteuerung – Sammlungsstücke und Antiquitäten',
    newTransportMean: 'Lieferung eines neuen Fahrzeugs',
    markings: 'Gesetzliche Angaben',
    notReported: 'Darstellung der an die NAV übermittelten Daten.',
    page: 'Seite',
  },
};

export function label(key: string, language: DocumentLanguage): string {
  return LABELS[language][key] ?? LABELS.hu[key] ?? key;
}

const UNITS: Record<DocumentLanguage, Record<UnitOfMeasureType, string>> = {
  hu: {
    PIECE: 'db',
    KILOGRAM: 'kg',
    TON: 't',
    KWH: 'kWh',
    DAY: 'nap',
    HOUR: 'óra',
    MINUTE: 'perc',
    MONTH: 'hónap',
    LITER: 'l',
    KILOMETER: 'km',
    CUBIC_METER: 'm³',
    METER: 'm',
    LINEAR_METER: 'fm',
    CARTON: 'karton',
    PACK: 'csomag',
    OWN: '',
  },
  en: {
    PIECE: 'pcs',
    KILOGRAM: 'kg',
    TON: 't',
    KWH: 'kWh',
    DAY: 'day',
    HOUR: 'hour',
    MINUTE: 'min',
    MONTH: 'month',
    LITER: 'l',
    KILOMETER: 'km',
    CUBIC_METER: 'm³',
    METER: 'm',
    LINEAR_METER: 'lm',
    CARTON: 'carton',
    PACK: 'pack',
    OWN: '',
  },
  de: {
    PIECE: 'Stk',
    KILOGRAM: 'kg',
    TON: 't',
    KWH: 'kWh',
    DAY: 'Tag',
    HOUR: 'Std',
    MINUTE: 'Min',
    MONTH: 'Monat',
    LITER: 'l',
    KILOMETER: 'km',
    CUBIC_METER: 'm³',
    METER: 'm',
    LINEAR_METER: 'lfm',
    CARTON: 'Karton',
    PACK: 'Packung',
    OWN: '',
  },
};

export function unitLabel(
  unit: UnitOfMeasureType | undefined,
  own: string | undefined,
  language: DocumentLanguage,
): string {
  if (unit === 'OWN') return own ?? '';
  return unit ? UNITS[language][unit] : '';
}

const PAYMENT_METHODS: Record<DocumentLanguage, Record<PaymentMethodType, string>> = {
  hu: {
    TRANSFER: 'átutalás',
    CASH: 'készpénz',
    CARD: 'bankkártya',
    VOUCHER: 'utalvány',
    OTHER: 'egyéb',
  },
  en: {
    TRANSFER: 'bank transfer',
    CASH: 'cash',
    CARD: 'card',
    VOUCHER: 'voucher',
    OTHER: 'other',
  },
  de: {
    TRANSFER: 'Überweisung',
    CASH: 'Bar',
    CARD: 'Karte',
    VOUCHER: 'Gutschein',
    OTHER: 'Sonstige',
  },
};

export function paymentMethodLabel(
  method: PaymentMethodType | undefined,
  language: DocumentLanguage,
): string {
  return method ? PAYMENT_METHODS[language][method] : '';
}

export function documentTitle(
  category: InvoiceCategoryType | undefined,
  isModification: boolean,
  language: DocumentLanguage,
): string {
  if (isModification) return label('modificationDocument', language);
  if (category === 'SIMPLIFIED') return label('simplifiedInvoice', language);
  if (category === 'AGGREGATE') return label('aggregateInvoice', language);
  return label('invoice', language);
}

export function marginSchemeLabel(scheme: MarginSchemeType, language: DocumentLanguage): string {
  switch (scheme) {
    case 'TRAVEL_AGENCY':
      return label('marginTravel', language);
    case 'SECOND_HAND':
      return label('marginSecondHand', language);
    case 'ARTWORK':
      return label('marginArtwork', language);
    default:
      return label('marginAntiques', language);
  }
}
