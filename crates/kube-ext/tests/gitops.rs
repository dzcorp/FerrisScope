use std::collections::HashSet;

use ferrisscope_kube_ext::{
    registry::{self, Category, DiscoveredCrd, ResourceKindEntry},
    well_known,
};
use kube::api::DynamicObject;
use serde_json::Value;

#[test]
fn gitops_fixtures_cover_every_kind_and_preserve_detail_contract() {
    let objects: Vec<DynamicObject> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/well_known/gitops.json"
    ))
    .unwrap();
    let mut seen = HashSet::new();
    for obj in objects {
        let types = obj.types.as_ref().unwrap();
        let (group, version) = types.api_version.split_once('/').unwrap();
        let wk = well_known::lookup_by_gk(group, &types.kind).unwrap();
        assert!(seen.insert(wk.short_id));
        let row = (wk.project)(&obj);
        for c in (wk.columns)() {
            assert!(
                row.get(c.id).is_some(),
                "missing {} column for {}",
                c.id,
                wk.kind
            );
        }
        assert!(serde_json::to_vec(&row).unwrap().len() < 1024);
        let detail = (wk.project_detail)(&obj);
        assert_eq!(
            detail["meta"]["name"],
            obj.metadata.name.as_deref().unwrap()
        );
        assert!(detail["meta"]["managers"].is_array());
        assert_eq!(
            detail["resource_version"],
            obj.metadata.resource_version.as_deref().unwrap()
        );
        let mut titles = HashSet::new();
        for section in detail["sections"].as_array().unwrap() {
            assert!(titles.insert(section["title"].as_str().unwrap()));
            let fields = section["fields"].as_array().unwrap().iter().chain(
                section["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|item| item["fields"].as_array().unwrap()),
            );
            for field in fields {
                assert!(field["label"].is_string());
                assert!(field["value"].is_null() || field["value"].is_string());
                if !field["reference"].is_null() {
                    assert!(field["reference"]["group"].is_string());
                    assert!(field["reference"]["local"].is_boolean());
                }
            }
        }
        let plural = types.kind.to_lowercase() + "s";
        for version in [version, "v1beta1"] {
            let entry = ResourceKindEntry::from_dynamic_crd(DiscoveredCrd {
                group: group.into(),
                version: version.into(),
                plural: plural.clone(),
                kind: types.kind.clone(),
                namespaced: true,
                printer_columns: vec![],
            });
            assert_eq!(entry.meta.category, Category::Apps);
            assert_eq!(entry.meta.version, version);
            assert_eq!(
                registry::lookup(entry.meta.id).unwrap().meta.id,
                entry.meta.id
            );
        }
        let rows = detail["sections"].as_array().unwrap();
        assert!(rows.len() >= 3, "{} lacks rich sections", wk.kind);
        if wk.kind == "Application" {
            assert!(detail["argo"]["history"].is_array());
            assert!(detail["argo"]["sources"].is_array());
        }
        if wk.short_id.starts_with("flux_") {
            assert!(detail["flux"]["history"].is_array());
        }
        assert_eq!(detail["cards"].as_array().unwrap().len(), 3);
        for card in detail["cards"].as_array().unwrap() {
            assert!(card["label"].is_string());
        }
        assert!(detail["conditions"].is_array());
        assert!(detail["resources"].is_null() || detail["resources"].is_array());
        for action in detail["actions"].as_array().unwrap() {
            assert!(action["id"].is_string());
            assert!(action["patch"].is_object());
            assert_eq!(action["patch"].get("status"), None);
        }
    }
    assert_eq!(seen.len(), 10);
    let mut ids = HashSet::new();
    for wk in well_known::registry() {
        assert!(ids.insert(wk.short_id), "duplicate short id");
        assert!(!registry::registry()
            .iter()
            .any(|k| k.meta.id == wk.short_id));
    }
}

#[test]
fn actions_are_removed_during_deletion() {
    let mut objects: Vec<DynamicObject> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/well_known/gitops.json"
    ))
    .unwrap();
    for obj in &mut objects {
        obj.metadata.deletion_timestamp =
            Some(serde_json::from_value(Value::String("2026-09-01T12:00:00Z".into())).unwrap());
        let types = obj.types.as_ref().unwrap();
        let group = types.api_version.split_once('/').unwrap().0;
        let wk = well_known::lookup_by_gk(group, &types.kind).unwrap();
        assert!((wk.project_detail)(obj)["actions"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
