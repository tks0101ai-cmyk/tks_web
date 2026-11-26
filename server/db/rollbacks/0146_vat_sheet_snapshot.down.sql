-- Stop VAT snapshot worker and roll back its consumers before running manually.
DROP TABLE IF EXISTS vat_sheet_snapshot;
