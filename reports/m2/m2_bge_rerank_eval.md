# M2 Server-Side BGE Rerank Eval

## Settings

- API base: `http://localhost:3101/api`
- Workspace: `m1-vlm-enriched-baseline-vlm-first`
- Corpus items uploaded: 216/216
- Query topN: 20; reported recall: R@1/R@3/R@5; MRR uses first relevant rank within top20.
- Ingest path: reuse M1 OCR + local VLM enriched workspace; server-side LanceDB candidate pool is reranked by local BGE service.

## Summary

| split | queries | R@1 | R@3 | R@5 | MRR | miss@5 | query_s | rerank_s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| all | 28 | 0.679 | 0.821 | 0.857 | 0.757 | 4 | 0.641 | 0.568 |
| pure_visual | 13 | 0.538 | 0.692 | 0.769 | 0.627 | 3 | 0.663 | 0.590 |
| text_or_ocr | 15 | 0.800 | 0.933 | 0.933 | 0.870 | 1 | 0.623 | 0.549 |

## By Category

| category | queries | R@1 | R@3 | R@5 | MRR |
|---|---:|---:|---:|---:|---:|
| chat_text | 3 | 1.000 | 1.000 | 1.000 | 1.000 |
| mixed_visual | 3 | 0.333 | 0.333 | 0.667 | 0.438 |
| ocr_ui | 1 | 1.000 | 1.000 | 1.000 | 1.000 |
| ocr_web | 2 | 1.000 | 1.000 | 1.000 | 1.000 |
| pdf_document | 2 | 1.000 | 1.000 | 1.000 | 1.000 |
| pure_visual_photo | 5 | 0.600 | 0.800 | 0.800 | 0.685 |
| pure_visual_ui | 1 | 1.000 | 1.000 | 1.000 | 1.000 |
| receipt_ocr | 1 | 0.000 | 0.000 | 0.000 | 0.053 |
| text_document | 4 | 1.000 | 1.000 | 1.000 | 1.000 |
| visual_plus_text_ui | 1 | 0.000 | 1.000 | 1.000 | 0.500 |
| visual_receipt | 1 | 1.000 | 1.000 | 1.000 | 1.000 |
| visual_scanned_form | 1 | 0.000 | 0.000 | 0.000 | 0.077 |
| visual_text_scene | 1 | 0.000 | 1.000 | 1.000 | 0.500 |
| visual_ui | 2 | 0.500 | 1.000 | 1.000 | 0.667 |

## Query Rows

| id | pure_visual | rank | query_s | rerank_s | top5 |
|---|---:|---:|---:|---:|---|
| q01_black_cat_sink | true | 1 | 0.650 | 0.555 | coco_284623, coco_304560, coco_115885, coco_117908, coco_427034 |
| q02_black_cat_grass | true | 1 | 0.832 | 0.760 | coco_304560, coco_221693, coco_115885, coco_284623, coco_116825 |
| q03_camera_next_to_phone | true | 11 | 0.769 | 0.695 | coco_120853, coco_480212, coco_259597, coco_113720, real_image_text_001 |
| q04_child_recording_stage | true | 1 | 0.614 | 0.541 | coco_259597, coco_480212, text_web_wikipedia_mobile_ecosia, doc_phone_backup, real_ui_screenshot_008 |
| q05_two_men_ties | true | 3 | 0.625 | 0.555 | coco_113720, real_image_text_010, coco_423506, real_image_text_021, real_image_text_027 |
| q06_rocket_clouds_page | true | 1 | 0.721 | 0.648 | real_ui_screenshot_001, real_ui_screenshot_009, real_ui_screenshot_012, real_ui_screenshot_029, coco_290179 |
| q07_bitly_cartoon | true | 3 | 0.616 | 0.543 | text_web_wikipedia_mobile_ecosia, real_ui_screenshot_028, real_ui_screenshot_009, real_ui_screenshot_020, real_ui_screenshot_012 |
| q08_airtable_collaboration | true | 1 | 0.746 | 0.675 | real_ui_screenshot_013, real_ui_screenshot_016, real_ui_screenshot_018, real_ui_screenshot_010, real_ui_screenshot_001 |
| q09_keyboard_continue_button | false | 2 | 0.750 | 0.626 | real_image_text_024, real_image_text_023, coco_115885, real_ui_screenshot_003, coco_541664 |
| q10_harry_potter_book_page | false | 2 | 0.605 | 0.534 | real_image_text_030, real_image_text_029, real_ui_screenshot_029, real_image_text_018, real_image_text_010 |
| q11_red_stamp_receipt | true | 1 | 0.609 | 0.540 | real_receipt_014, chat_home_repair, real_receipt_005, real_receipt_002, real_receipt_003 |
| q12_red_stamp_form | true | 13 | 0.611 | 0.540 | chat_home_repair, real_receipt_014, text_funsd_0011859695, text_funsd_0001485288, text_funsd_0000990274 |
| q13_wikipedia_mobile | false | 1 | 0.605 | 0.537 | text_mobile_aloha_iphone, text_web_wikipedia_mobile_ecosia, text_browser_floorp, text_mobile_commons_dr_table, text_mobile_firefox_commons_tools |
| q14_liberapay_feed | false | 1 | 0.610 | 0.541 | text_web_nitter_liberapay, real_ui_screenshot_003, real_ui_screenshot_020, real_ui_screenshot_010, real_ui_screenshot_018 |
| q15_floorp_browser | false | 1 | 0.606 | 0.537 | text_browser_floorp, chat_ui_bug, real_ui_screenshot_029, real_ui_screenshot_025, real_ui_screenshot_021 |
| q16_receipt_total | false | 19 | 0.609 | 0.539 | coru_receipt_004, coru_receipt_011, coru_receipt_012, coru_receipt_009, coru_receipt_014 |
| q17_apartment_keys | false | 1 | 0.613 | 0.540 | doc_apartment_move_checklist, real_ui_screenshot_011, real_ui_screenshot_028, text_funsd_0011899960, coru_receipt_010 |
| q18_bike_brake_pads | false | 1 | 0.612 | 0.541 | doc_bike_repair_quote, coru_receipt_012, coru_receipt_011, coco_140203, real_image_text_013 |
| q19_router_mesh_node | false | 1 | 0.611 | 0.540 | doc_home_router, real_image_text_022, coco_112626, real_image_text_026, text_funsd_0001123541 |
| q20_pdf_signature_area | false | 1 | 0.666 | 0.597 | pdf_public_demo_agreement, text_funsd_0011899960, text_funsd_0001477983, real_ui_screenshot_003, text_pdfjs_firefox |
| q21_ui_error_box | false | 1 | 0.614 | 0.538 | chat_ui_bug, chat_trip_planning, chat_receipt_cleanup, chat_home_repair, real_ui_screenshot_003 |
| q22_blue_couch_map_pin | false | 1 | 0.613 | 0.541 | chat_trip_planning, chat_ui_bug, chat_receipt_cleanup, chat_home_repair, text_web_wikipedia_mobile_ecosia |
| q23_local_ocr_vlm | false | 1 | 0.612 | 0.540 | chat_receipt_cleanup, real_receipt_010, real_receipt_009, real_receipt_013, real_receipt_007 |
| q24_laptop_and_keyboard | true | 4 | 0.609 | 0.539 | coco_115885, coco_427034, real_image_text_024, real_image_text_023, real_ui_screenshot_025 |
| q25_phone_in_photo | true | 1 | 0.606 | 0.537 | coco_480212, coco_259597, coco_112626, real_ui_screenshot_018, coco_147223 |
| q26_visual_receipt_or_ticket | true | 16 | 0.611 | 0.540 | real_receipt_005, real_receipt_008, real_receipt_013, coru_receipt_008, real_receipt_010 |
| q27_device_return_pdf | false | 1 | 0.607 | 0.540 | pdf_device_return_form, real_ui_screenshot_003, coco_480212, pdf_event_ticket_note, real_ui_screenshot_008 |
| q28_team_lunch | false | 1 | 0.609 | 0.538 | doc_team_lunch, real_receipt_015, coru_receipt_009, coru_receipt_017, coru_receipt_014 |
