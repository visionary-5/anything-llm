# M0 AnythingLLM True-Ingest Baseline

## Settings

- API base: `http://localhost:3101/api`
- Workspace: `m0-api-baseline-20260630-123419`
- Corpus items uploaded: 216/216
- Query topN: 20; reported recall: R@1/R@3/R@5; MRR uses first relevant rank within top20.
- Ingest path: real AnythingLLM upload API and collector; image files go through Tesseract OCR only.

## Summary

| split | queries | R@1 | R@3 | R@5 | MRR | miss@5 |
|---|---:|---:|---:|---:|---:|---:|
| all | 28 | 0.464 | 0.536 | 0.536 | 0.513 | 13 |
| pure_visual | 13 | 0.077 | 0.154 | 0.154 | 0.138 | 11 |
| text_or_ocr | 15 | 0.800 | 0.867 | 0.867 | 0.838 | 2 |

## By Category

| category | queries | R@1 | R@3 | R@5 | MRR |
|---|---:|---:|---:|---:|---:|
| chat_text | 3 | 1.000 | 1.000 | 1.000 | 1.000 |
| mixed_visual | 3 | 0.000 | 0.000 | 0.000 | 0.051 |
| ocr_ui | 1 | 1.000 | 1.000 | 1.000 | 1.000 |
| ocr_web | 2 | 1.000 | 1.000 | 1.000 | 1.000 |
| pdf_document | 2 | 1.000 | 1.000 | 1.000 | 1.000 |
| pure_visual_photo | 5 | 0.000 | 0.000 | 0.000 | 0.011 |
| pure_visual_ui | 1 | 0.000 | 0.000 | 0.000 | 0.000 |
| receipt_ocr | 1 | 0.000 | 0.000 | 0.000 | 0.071 |
| text_document | 4 | 1.000 | 1.000 | 1.000 | 1.000 |
| visual_plus_text_ui | 1 | 0.000 | 0.000 | 0.000 | 0.000 |
| visual_receipt | 1 | 0.000 | 0.000 | 0.000 | 0.083 |
| visual_scanned_form | 1 | 0.000 | 0.000 | 0.000 | 0.000 |
| visual_text_scene | 1 | 0.000 | 1.000 | 1.000 | 0.500 |
| visual_ui | 2 | 0.500 | 1.000 | 1.000 | 0.750 |

## Query Rows

| id | pure_visual | rank | top5 |
|---|---:|---:|---|
| q01_black_cat_sink | true | 18 | doc_cat_vet_notes, real_image_text_008, real_image_text_007, chat_home_repair, real_image_text_018 |
| q02_black_cat_grass | true | miss | doc_cat_vet_notes, doc_photo_archive_notes, real_image_text_008, real_ui_screenshot_021, real_image_text_007 |
| q03_camera_next_to_phone | true | miss | doc_photo_archive_notes, doc_phone_backup, real_ui_screenshot_021, real_image_text_015, real_image_text_023 |
| q04_child_recording_stage | true | miss | pdf_event_ticket_note, doc_phone_backup, real_image_text_023, doc_photo_archive_notes, real_image_text_024 |
| q05_two_men_ties | true | miss | real_image_text_009, coco_450202, real_image_text_027, real_image_text_028, real_image_text_010 |
| q06_rocket_clouds_page | true | miss | real_ui_screenshot_011, real_ui_screenshot_018, real_image_text_022, real_image_text_019, real_image_text_020 |
| q07_bitly_cartoon | true | 1 | real_ui_screenshot_009, real_image_text_002, real_ui_screenshot_021, real_image_text_022, real_image_text_012 |
| q08_airtable_collaboration | true | 2 | real_ui_screenshot_016, real_ui_screenshot_013, real_ui_screenshot_018, real_image_text_022, real_ui_screenshot_008 |
| q09_keyboard_continue_button | false | miss | doc_desk_setup, real_ui_screenshot_011, real_ui_screenshot_018, real_image_text_017, real_ui_screenshot_003 |
| q10_harry_potter_book_page | false | 2 | real_image_text_030, real_image_text_029, doc_photo_archive_notes, real_image_text_028, real_image_text_022 |
| q11_red_stamp_receipt | true | 12 | real_receipt_013, real_receipt_012, real_receipt_005, real_receipt_008, coru_receipt_012 |
| q12_red_stamp_form | true | miss | text_funsd_0001463448, chat_home_repair, coru_receipt_012, pdf_public_demo_agreement, real_receipt_013 |
| q13_wikipedia_mobile | false | 1 | text_mobile_aloha_iphone, text_browser_floorp, real_ui_screenshot_011, real_image_text_022, text_mobile_commons_dr_table |
| q14_liberapay_feed | false | 1 | text_web_nitter_liberapay, real_ui_screenshot_009, real_ui_screenshot_011, real_chart_009, real_chart_010 |
| q15_floorp_browser | false | 1 | text_browser_floorp, real_ui_screenshot_018, real_ui_screenshot_011, real_ui_screenshot_008, real_image_text_022 |
| q16_receipt_total | false | 14 | real_receipt_013, real_receipt_002, real_receipt_009, coru_receipt_016, real_receipt_005 |
| q17_apartment_keys | false | 1 | doc_apartment_move_checklist, doc_rental_car, doc_lease_clause, real_ui_screenshot_008, coru_receipt_012 |
| q18_bike_brake_pads | false | 1 | doc_bike_repair_quote, real_image_text_021, text_funsd_87528380, coru_receipt_012, real_image_text_017 |
| q19_router_mesh_node | false | 1 | doc_home_router, real_image_text_011, doc_apartment_move_checklist, text_browser_floorp, real_ui_screenshot_008 |
| q20_pdf_signature_area | false | 1 | pdf_public_demo_agreement, text_pdfjs_firefox, text_funsd_0001463448, real_image_text_010, coru_receipt_012 |
| q21_ui_error_box | false | 1 | chat_ui_bug, real_image_text_022, real_ui_screenshot_011, chat_home_repair, coco_290179 |
| q22_blue_couch_map_pin | false | 1 | chat_trip_planning, chat_ui_bug, real_ui_screenshot_011, chat_home_repair, real_ui_screenshot_003 |
| q23_local_ocr_vlm | false | 1 | chat_receipt_cleanup, chat_home_repair, real_receipt_013, real_receipt_012, coru_receipt_012 |
| q24_laptop_and_keyboard | true | 16 | real_ui_screenshot_011, real_ui_screenshot_018, doc_desk_setup, doc_photo_archive_notes, real_image_text_017 |
| q25_phone_in_photo | true | miss | doc_photo_archive_notes, doc_phone_backup, real_image_text_023, coco_135670, real_image_text_024 |
| q26_visual_receipt_or_ticket | true | 11 | doc_photo_archive_notes, real_receipt_013, real_receipt_012, real_image_text_022, coru_receipt_012 |
| q27_device_return_pdf | false | 1 | pdf_device_return_form, real_ui_screenshot_011, real_ui_screenshot_018, pdf_event_ticket_note, coco_135670 |
| q28_team_lunch | false | 1 | doc_team_lunch, coru_receipt_009, real_receipt_015, coru_receipt_004, coru_receipt_020 |
